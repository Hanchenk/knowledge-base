//! Query constraints and transparent evidence ranking shared by both databases.
use crate::db::{s, Record};
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::LazyLock};

static MONTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:([0-9]{4})年)?(1[0-2]|0?[1-9])月").unwrap());
static DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(20[0-9]{2})[-/年](1[0-2]|0?[1-9])[-/月](3[01]|[12][0-9]|0?[1-9])").unwrap()
});
static MONTH_DAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(1[0-2]|0?[1-9])月(3[01]|[12][0-9]|0?[1-9])日").unwrap());
static YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(20[0-9]{2})年").unwrap());

#[derive(Default)]
pub struct Intent {
    months: HashSet<u32>,
    years: HashSet<u32>,
    dates: HashSet<(u32, u32, u32)>,
    days: HashSet<u32>,
    pub summary: bool,
}
impl Intent {
    pub fn parse(query: &str) -> Self {
        let mut value = Self::default();
        for capture in MONTH.captures_iter(query) {
            value.months.insert(capture[2].parse().unwrap());
        }
        for capture in YEAR.captures_iter(query) {
            value.years.insert(capture[1].parse().unwrap());
        }
        for capture in DATE.captures_iter(query) {
            let date = (
                capture[1].parse().unwrap(),
                capture[2].parse().unwrap(),
                capture[3].parse().unwrap(),
            );
            value.years.insert(date.0);
            value.months.insert(date.1);
            value.dates.insert(date);
            value.days.insert(date.2);
        }
        for capture in MONTH_DAY.captures_iter(query) {
            value.months.insert(capture[1].parse().unwrap());
            value.days.insert(capture[2].parse().unwrap());
        }
        value.summary = ["汇总", "统计", "总结", "合计", "各场站", "各电站", "全月"]
            .iter()
            .any(|word| query.contains(word))
            && value.days.is_empty();
        value
    }
    pub fn dated(&self) -> bool {
        !self.months.is_empty() || !self.years.is_empty()
    }
    pub fn constrain_chunks(&self, filter: &mut String, args: &mut Vec<Value>) {
        if !self.dated() {
            return;
        }
        let years: Vec<_> = if self.years.is_empty() {
            vec!["%".to_owned()]
        } else {
            self.years.iter().map(|v| v.to_string()).collect()
        };
        let months: Vec<_> = if self.months.is_empty() {
            vec!["%".to_owned()]
        } else {
            self.months.iter().map(|v| format!("{v:02}")).collect()
        };
        let days: Vec<_> = if self.days.is_empty() {
            vec!["%".to_owned()]
        } else {
            self.days.iter().map(|v| format!("{v:02}")).collect()
        };
        let mut predicates = vec!["c.text NOT LIKE '%；日期：%'".to_owned()];
        for year in &years {
            for month in &months {
                for day in &days {
                    predicates.push("c.text LIKE ?".into());
                    args.push(json!(format!("%工作表：%；日期：{year}-{month}-{day}；%")));
                }
            }
        }
        filter.push_str(&format!(
            " AND (c.kind NOT IN ('table','table_summary') OR (c.kind='table' AND ({}))",
            predicates.join(" OR ")
        ));
        if self.days.is_empty() {
            let mut summary = Vec::new();
            for year in &years {
                for month in &months {
                    summary.push("c.text LIKE ?".to_owned());
                    let month = month
                        .parse::<u32>()
                        .map(|v| v.to_string())
                        .unwrap_or_else(|_| "%".into());
                    args.push(json!(format!("{year}年{month}月各场站日报数据汇总%")));
                }
            }
            filter.push_str(&format!(
                " OR (c.kind='table_summary' AND ({}))",
                summary.join(" OR ")
            ));
        }
        filter.push(')');
    }
    pub fn document_matches(&self, row: &Record) -> bool {
        let text = format!("{} {}", s(row, "title"), s(row, "filename"));
        let doc = Self::parse(&text);
        // Undated documents remain eligible unless a dated report is identified.
        (self.months.is_empty() || doc.months.is_empty() || !self.months.is_disjoint(&doc.months))
            && (self.years.is_empty()
                || doc.years.is_empty()
                || !self.years.is_disjoint(&doc.years))
    }
    pub fn dated_document_matches(&self, row: &Record) -> bool {
        let doc = Self::parse(&format!("{} {}", s(row, "title"), s(row, "filename")));
        self.document_matches(row)
            && ((!self.months.is_empty() && !doc.months.is_empty())
                || (!self.years.is_empty() && !doc.years.is_empty()))
    }
    pub fn chunk_matches(&self, row: &Record) -> bool {
        // Only use parser-generated report metadata, not dates inside notes.
        let text = s(row, "text");
        if s(row, "kind") == "table_summary" {
            if !self.days.is_empty() {
                return false;
            }
            let summary = Self::parse(text.lines().next().unwrap_or(""));
            return (self.months.is_empty() || !self.months.is_disjoint(&summary.months))
                && (self.years.is_empty() || !self.years.is_disjoint(&summary.years));
        }
        let Some(line) = text
            .lines()
            .find(|line| line.starts_with("工作表：") && line.contains("；日期："))
        else {
            return true;
        };
        DATE.captures_iter(line).any(|c| {
            let date = (
                c[1].parse().unwrap(),
                c[2].parse().unwrap(),
                c[3].parse().unwrap(),
            );
            (self.months.is_empty() || self.months.contains(&date.1))
                && (self.years.is_empty() || self.years.contains(&date.0))
                && (self.days.is_empty() || self.days.contains(&date.2))
                && (self.dates.is_empty() || self.dates.contains(&date))
        })
    }
}

pub fn title_overlap(query: &str, title: &str) -> usize {
    let meaningful: HashSet<_> = crate::rag::tokens(query)
        .into_iter()
        .filter(|t| {
            t.chars().count() >= 2
                && !t.chars().all(|c| c.is_ascii_digit())
                && ![
                    "汇总", "数据", "一下", "给我", "各场", "场站", "全月", "统计", "总结", "合计",
                ]
                .contains(&t.as_str())
        })
        .collect();
    let title: HashSet<_> = crate::rag::tokens(title).into_iter().collect();
    meaningful.intersection(&title).count()
}

pub fn evidence_bonus(intent: &Intent, query: &str, row: &Record) -> f64 {
    let overlap = title_overlap(query, s(row, "title")) as f64;
    let summary = intent.summary && s(row, "kind") == "table_summary";
    // Reorder fused evidence by document identity and structured summary intent.
    // This is a deterministic ranker, not a neural cross-encoder model.
    0.004 * overlap + if summary { 0.1 } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn row(title: &str, text: &str) -> Record {
        json!({"title": title, "filename": "", "text": text, "kind":"table"})
            .as_object()
            .unwrap()
            .clone()
    }
    #[test]
    fn explicit_month_and_day_do_not_match_incident_notes() {
        let q = Intent::parse("国烁2025年11月日报汇总");
        assert!(q.summary);
        assert!(!q.document_matches(&row("国烁2025年10月日报", "11月事故")));
        assert!(q.document_matches(&row("国烁2025年11月日报", "10月事故")));
        assert!(!q.document_matches(&row("国烁2024年11月日报", "")));
        let q = Intent::parse("2025-11-30发电量");
        assert!(!q.chunk_matches(&row(
            "",
            "工作表：1；日期：2025-11-01；行：6\n事故日期2025-11-30"
        )));
        assert!(q.chunk_matches(&row("", "工作表：30；日期：2025-11-30；行：6")));
        let q = Intent::parse("10月和11月对比");
        assert!(q.document_matches(&row("2025年10月日报", "")));
        assert!(q.document_matches(&row("2025年11月日报", "")));
    }
}
