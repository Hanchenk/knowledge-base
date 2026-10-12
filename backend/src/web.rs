//! Public web tools. Knowledge tools never use this network client.
use crate::{
    error::{AppError, Result},
    AppState,
};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{net::IpAddr, time::Duration};

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || (a == 192 && b == 0 && c == 0))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let segments = ip.segments();
            // Only global unicast; reject local, link-local, multicast, transition and documentation ranges.
            (segments[0] & 0xe000 == 0x2000)
                && !(segments[0] == 0x2001 && (segments[1] < 0x0200 || segments[1] == 0x0db8))
                && segments[0] != 0x2002
        }
    }
}
pub fn public_url(raw: &str) -> Result<Url> {
    if raw.len() > 2048 {
        return Err(AppError::bad("网页地址过长"));
    }
    let url = Url::parse(raw).map_err(|_| AppError::bad("网页地址无效"))?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443))
    {
        return Err(AppError::bad("仅允许读取公开的 HTTP/HTTPS 网页"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::bad("网页地址缺少域名"))?;
    let host = host.trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.parse::<IpAddr>().is_ok_and(|ip| !public_ip(ip))
    {
        return Err(AppError::bad("不能访问内网、本机或云元数据地址"));
    }
    Ok(url)
}
async fn bounded_body(mut response: reqwest::Response) -> Result<String> {
    if !response.status().is_success() {
        return Err(AppError::bad(format!(
            "联网服务返回 HTTP {}",
            response.status().as_u16()
        )));
    }
    if response.content_length().is_some_and(|n| n > 2_000_000) {
        return Err(AppError::bad("网页内容超过 2 MB"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::bad("读取联网内容失败"))?
    {
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err(AppError::bad("网页内容超过 2 MB"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
async fn public_response(raw: &str) -> Result<(String, reqwest::Response)> {
    let mut url = public_url(raw)?;
    for _ in 0..=3 {
        let host = url.host_str().unwrap().trim_matches(['[', ']']).to_owned();
        let addresses = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host.as_str(), url.port_or_known_default().unwrap())),
        )
        .await
        .map_err(|_| AppError::bad("网页域名解析超时"))?
        .map_err(|_| AppError::bad("网页域名解析失败"))?
        .collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err(AppError::bad("不能访问内网、本机或云元数据地址"));
        }
        // Pin the checked DNS result, disable proxies and validate each redirect destination.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .resolve_to_addrs(&host, &addresses)
            .user_agent("Atlas-Knowledge-Agent/0.1")
            .build()
            .map_err(|_| AppError::bad("联网客户端初始化失败"))?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| AppError::bad("联网访问失败或超时"))?;
        if matches!(
            response.status(),
            StatusCode::MOVED_PERMANENTLY
                | StatusCode::FOUND
                | StatusCode::SEE_OTHER
                | StatusCode::TEMPORARY_REDIRECT
                | StatusCode::PERMANENT_REDIRECT
        ) {
            let destination = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| AppError::bad("网页跳转缺少地址"))?;
            url = public_url(
                url.join(destination)
                    .map_err(|_| AppError::bad("网页跳转地址无效"))?
                    .as_str(),
            )?;
            continue;
        }
        return Ok((url.to_string(), response));
    }
    Err(AppError::bad("网页跳转次数过多"))
}
async fn public_get(raw: &str) -> Result<(String, String)> {
    let (url, response) = public_response(raw).await?;
    let kind = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if ![
        "text/",
        "application/xml",
        "application/rss+xml",
        "application/xhtml+xml",
    ]
    .iter()
    .any(|prefix| kind.starts_with(prefix))
    {
        return Err(AppError::bad("网页读取只支持文本、HTML 和 XML"));
    }
    Ok((url, bounded_body(response).await?))
}
pub(crate) async fn download_public(raw: &str, maximum: usize) -> Result<Vec<u8>> {
    let (_, mut response) = public_response(raw).await?;
    if !response.status().is_success() {
        return Err(AppError::bad("下载生成文件失败"));
    }
    if response
        .content_length()
        .is_some_and(|n| n > maximum as u64)
    {
        return Err(AppError::bad("生成文件超过大小限制"));
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::bad("读取生成文件失败"))?
    {
        if data.len() + chunk.len() > maximum {
            return Err(AppError::bad("生成文件超过大小限制"));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
fn text(raw: &str, limit: usize) -> String {
    let scripts = regex::Regex::new(
        r"(?is)<(script|style|noscript)\b[^>]*>.*?</(?:script|style|noscript)\s*>",
    )
    .unwrap();
    let tags = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let plain = scripts.replace_all(raw, " ");
    let plain = tags.replace_all(&plain, " ");
    let decoded = quick_xml::escape::unescape(&plain)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| plain.into_owned());
    decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}
fn page(url: &str, body: &str, start: usize, limit: usize) -> Result<Value> {
    let title = regex::Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>")
        .unwrap()
        .captures(body)
        .map(|c| text(&c[1], 200))
        .unwrap_or_else(|| url.to_owned());
    // Offsets count normalized Unicode characters, not bytes.
    let plain = text(body, 200_001);
    if plain.is_empty() {
        return Err(AppError::bad("网页没有可读取正文"));
    }
    let source_truncated = plain.chars().count() > 200_000;
    let total = plain.chars().count().min(200_000);
    let start = start.min(total);
    let content: String = plain
        .chars()
        .skip(start)
        .take(limit.min(total - start))
        .collect();
    let end = start + content.chars().count();
    Ok(
        json!({"url":url,"title":title,"content":content,"start":start,"total_chars":total,"next_start":if end<total {json!(end)}else{Value::Null},"source_truncated":source_truncated}),
    )
}
pub async fn fetch(raw: &str, start: usize, limit: usize) -> Result<Value> {
    let (url, body) = public_get(raw).await?;
    page(&url, &body, start.min(200_000), limit.clamp(1000, 12000))
}
#[derive(Deserialize)]
struct Rss {
    channel: Channel,
}
#[derive(Deserialize)]
struct Channel {
    #[serde(default)]
    item: Vec<Item>,
}
#[derive(Deserialize)]
struct Item {
    #[serde(default)]
    title: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    description: String,
}
pub async fn search(state: &AppState, query: &str) -> Result<Vec<Value>> {
    if query.trim().is_empty() || query.chars().count() > 500 {
        return Err(AppError::bad("联网检索词需为 1–500 个字符"));
    }
    let items = if state.config.web_search_url.is_empty() {
        let mut url = Url::parse("https://www.bing.com/search").unwrap();
        url.query_pairs_mut()
            .append_pair("format", "rss")
            .append_pair("q", query);
        let (_, body) = public_get(url.as_str()).await?;
        let feed: Rss = quick_xml::de::from_str(&body)
            .map_err(|_| AppError::bad("公开搜索服务未返回有效结果；可由管理员配置 SearXNG"))?;
        feed.channel.item.into_iter().map(|item|json!({"title":text(&item.title,200),"url":item.link,"snippet":text(&item.description,1500)})).collect::<Vec<_>>()
    } else {
        // Deployment-owned SearXNG endpoint; not an agent-selected URL.
        let response = state
            .http
            .get(&state.config.web_search_url)
            .query(&[("q", query), ("format", "json")])
            .send()
            .await
            .map_err(|_| AppError::bad("SearXNG 搜索服务访问失败"))?;
        let payload: Value = serde_json::from_str(&bounded_body(response).await?)
            .map_err(|_| AppError::bad("搜索服务未返回 JSON"))?;
        payload["results"].as_array().ok_or_else(|| AppError::bad("搜索服务响应缺少 results"))?.iter().map(|r|
            json!({"title":text(r["title"].as_str().unwrap_or(""),200),"url":r["url"],"snippet":text(r["content"].as_str().unwrap_or(""),1500)})).collect()
    };
    Ok(items
        .into_iter()
        .filter(|v| public_url(v["url"].as_str().unwrap_or("")).is_ok())
        .take(6)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    #[test]
    fn agent_web_blocks_private_and_disguised_destinations() {
        for url in [
            "http://127.0.0.1",
            "http://2130706433",
            "http://0x7f000001",
            "http://10.1.2.3",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]",
            "http://[::ffff:127.0.0.1]",
            "http://[fc00::1]",
            "http://localhost",
            "http://service.local",
            "https://example.com:8000",
            "https://user:secret@example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(public_url(url).is_err(), "{url}");
        }
        for ip in [
            Ipv4Addr::new(100, 64, 1, 1),
            Ipv4Addr::new(198, 18, 0, 1),
            Ipv4Addr::new(192, 0, 0, 1),
        ] {
            assert!(!public_ip(ip.into()));
        }
        assert!(public_url("https://example.com/docs").is_ok());
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
        assert_eq!(
            text(
                "<style>hide</style><h1>A &amp; B</h1><script>ignore</script>",
                100
            ),
            "A & B"
        );
    }
}

#[cfg(test)]
mod pagination_tests {
    use super::*;
    #[test]
    fn unicode_pages_reach_the_tail_without_repeating_the_head() {
        let body = format!(
            "<html><title>研究资料</title><script>hidden</script><p>{}</p><p>尾部结论</p></html>",
            "正文资料".repeat(5000)
        );
        let mut start = 0;
        let mut collected = String::new();
        loop {
            let value = page("https://example.com/article", &body, start, 6000).unwrap();
            assert_eq!(value["start"], start);
            collected.push_str(value["content"].as_str().unwrap());
            if let Some(next) = value["next_start"].as_u64() {
                assert!(next > start as u64);
                start = next as usize;
            } else {
                break;
            }
        }
        assert!(collected.ends_with("尾部结论"));
        assert!(!collected.contains("hidden"));
        let empty = page("https://example.com/article", &body, 200000, 6000).unwrap();
        assert_eq!(empty["content"], "");
        assert!(empty["next_start"].is_null());
    }
    #[test]
    fn bounded_extraction_reports_incomplete_source() {
        let value = page(
            "https://example.com/large",
            &"字".repeat(210000),
            198000,
            6000,
        )
        .unwrap();
        assert_eq!(value["total_chars"], 200000);
        assert_eq!(value["content"].as_str().unwrap().chars().count(), 2000);
        assert_eq!(value["source_truncated"], true);
        assert!(value["next_start"].is_null());
    }
}
