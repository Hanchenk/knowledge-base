//! Real JPEG fixtures verify that stored pixels and browser masks share coordinates.
use atlas_server::{
    auth,
    config::Config,
    db::{id, now, s},
    studio_inputs, AppState,
};
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    process::Command,
    sync::{Arc, Mutex},
};
use tempfile::TempDir;
use tower::ServiceExt;

struct Harness {
    state: AppState,
    router: Router,
    _directory: TempDir,
}
impl Harness {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut config = Config::load().unwrap();
        config.production = false;
        config.database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("orientation.db").display()
        );
        config.storage_path = directory.path().join("files");
        config.harness_path = directory.path().join("harness");
        config.harness_enabled = false;
        config.s3_endpoint.clear();
        config.s3_bucket.clear();
        config.s3_access_key.clear();
        config.s3_secret_key.clear();
        config.qdrant_url.clear();
        config.seed_demo = false;
        config.worker_enabled = false;
        config.agent_enabled = false;
        config.ai_api_key.clear();
        config.chat_api_key.clear();
        config.vision_api_key.clear();
        config.embedding_api_key.clear();
        config.chat_model.clear();
        config.vision_model.clear();
        config.embedding_model.clear();
        config.processor_python = root
            .join("processor/.venv/bin/python")
            .to_string_lossy()
            .into();
        config.processor_script = root.join("processor/extract.py").to_string_lossy().into();
        config.cors_origins = vec!["http://127.0.0.1:5173".into()];
        let state = AppState::new(config).await.unwrap();
        state.db.exec("INSERT INTO tenants(id,slug,name) VALUES('orientation-team','orientation-team','Orientation test')", vec![]).await.unwrap();
        state.db.exec("INSERT INTO users(id,tenant_id,email,name,password_hash,active,created_at) VALUES('orientation-user','orientation-team','orientation@test.invalid','Orientation test','unused',1,?)",vec![json!(now())]).await.unwrap();
        state
            .db
            .exec(
                "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,'orientation-user',?)",
                vec![
                    json!(auth::hash("orientation-session")),
                    json!(now() + 3600000),
                ],
            )
            .await
            .unwrap();
        Self {
            router: atlas_server::router(state.clone()),
            state,
            _directory: directory,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Vec<u8>,
        mime: &str,
    ) -> (StatusCode, Vec<u8>) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("cookie", "atlas_session=orientation-session")
            .header("origin", "http://127.0.0.1:5173")
            .header("content-type", mime)
            .body(Body::from(body))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        (
            response.status(),
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
    }
    async fn upload(&self, name: &str, bytes: &[u8]) -> Value {
        let mut body = format!("--orientation-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
        body.extend(bytes);
        body.extend(b"\r\n--orientation-boundary--\r\n");
        let (status, bytes) = self
            .request(
                "POST",
                "/api/studio/attachments",
                body,
                "multipart/form-data; boundary=orientation-boundary",
            )
            .await;
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status, StatusCode::OK, "{value}");
        value
    }
    fn python(&self, code: &str, args: &[String]) -> Value {
        let output = Command::new(&self.state.config.processor_python)
            .arg("-c")
            .arg(code)
            .args(args)
            .env_clear()
            .env("PYTHONUTF8", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}
const FIXTURES: &str = r#"
import base64, io, json
from PIL import Image, ImageDraw
image = Image.new('RGB', (80, 40))
draw = ImageDraw.Draw(image)
for box, color in [((0,0,39,19),(255,0,0)),((40,0,79,19),(0,255,0)),((0,20,39,39),(0,0,255)),((40,20,79,39),(255,255,0))]:
    draw.rectangle(box, fill=color)
cases = []
for orientation in range(1, 9):
    exif = Image.Exif()
    exif[274] = orientation
    encoded = io.BytesIO()
    image.save(encoded, 'JPEG', quality=100, subsampling=0, exif=exif)
    width, height = (40, 80) if orientation >= 5 else (80, 40)
    mask = Image.new('RGBA', (width, height), (255,255,255,255))
    ImageDraw.Draw(mask).rectangle((0,0,10,10), fill=(0,0,0,0))
    mask_bytes = io.BytesIO()
    mask.save(mask_bytes, 'PNG')
    cases.append({'orientation':orientation, 'jpeg':base64.b64encode(encoded.getvalue()).decode(), 'mask':base64.b64encode(mask_bytes.getvalue()).decode()})
print(json.dumps(cases))
"#;
const PIXELS: &str = r#"
import base64, io, json, sys
from PIL import Image
with Image.open(io.BytesIO(base64.b64decode(sys.argv[1]))) as image:
    width, height = image.size
    print(json.dumps({'orientation':image.getexif().get(274,1),'corners':[list(image.getpixel(point)) for point in [(5,5),(width-6,5),(5,height-6),(width-6,height-6)]]}))
"#;

#[tokio::test]
async fn uploaded_jpeg_orientation_matches_pixel_corners_and_mask_validation() {
    let harness = Harness::new().await;
    let fixtures = harness.python(FIXTURES, &[]);
    let (status, project) = harness
        .request(
            "POST",
            "/api/studio/projects",
            serde_json::to_vec(&json!({"title":"方向与遮罩回归"})).unwrap(),
            "application/json",
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let project: Value = serde_json::from_slice(&project).unwrap();
    let colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    // Expected top-left, top-right, bottom-left and bottom-right source corners.
    let expected_corners = [
        [0, 1, 2, 3],
        [1, 0, 3, 2],
        [3, 2, 1, 0],
        [2, 3, 0, 1],
        [0, 2, 1, 3],
        [2, 0, 3, 1],
        [3, 1, 2, 0],
        [1, 3, 0, 2],
    ];
    for fixture in fixtures.as_array().unwrap() {
        let orientation = fixture["orientation"].as_u64().unwrap() as usize;
        let source = STANDARD.decode(fixture["jpeg"].as_str().unwrap()).unwrap();
        assert_eq!(studio_inputs::dimensions(&source), Some((80, 40)));
        let image = harness.upload("phone.jpg", &source).await;
        let (status, stored) = harness
            .request(
                "GET",
                &format!("/api/studio/attachments/{}", image["id"].as_str().unwrap()),
                vec![],
                "application/json",
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(image["mime_type"], "image/jpeg");
        assert_eq!(image["size"].as_u64().unwrap(), stored.len() as u64);
        let expected = if orientation >= 5 { (40, 80) } else { (80, 40) };
        assert_eq!(
            studio_inputs::dimensions(&stored),
            Some(expected),
            "orientation {orientation}"
        );
        if orientation == 1 {
            assert_eq!(
                stored, source,
                "ordinary JPEG must retain its original bytes"
            );
        }
        let pixels = harness.python(PIXELS, &[STANDARD.encode(&stored)]);
        assert_eq!(
            pixels["orientation"], 1,
            "normalized JPEG must not rotate a second time"
        );
        for (corner, expected_index) in expected_corners[orientation - 1].iter().enumerate() {
            for channel in 0..3 {
                let actual = pixels["corners"][corner][channel].as_i64().unwrap();
                assert!(
                    (actual - colors[*expected_index][channel]).abs() <= 10,
                    "orientation {orientation}, corner {corner}, channel {channel}: {actual}"
                );
            }
        }
        let mask = STANDARD.decode(fixture["mask"].as_str().unwrap()).unwrap();
        assert_eq!(studio_inputs::dimensions(&mask), Some(expected));
        let mask = harness.upload("selection.png", &mask).await;
        let mut input = json!({"project_id":project["id"],"request_id":id(),"prompt":"仅擦除标记区域","kind":"image","image_size":"1024x1024","video_size":"1280x720","seconds":4,"operation":"erase","attachment_ids":[image["id"]],"mask_attachment_id":mask["id"]});
        let (status, response) = harness
            .request(
                "POST",
                "/api/studio/chat",
                serde_json::to_vec(&input).unwrap(),
                "application/json",
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let response: Value = serde_json::from_slice(&response).unwrap();
        // The deliberately disabled Agent is reached only after a successful mask check.
        assert!(
            response["error"].as_str().unwrap().contains("请先启用"),
            "orientation {orientation}: {response}"
        );
        if orientation >= 5 {
            let wrong = harness
                .upload(
                    "wrong-selection.png",
                    &STANDARD
                        .decode(fixtures[0]["mask"].as_str().unwrap())
                        .unwrap(),
                )
                .await;
            input["request_id"] = json!(id());
            input["mask_attachment_id"] = wrong["id"].clone();
            let (status, response) = harness
                .request(
                    "POST",
                    "/api/studio/chat",
                    serde_json::to_vec(&input).unwrap(),
                    "application/json",
                )
                .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            let response: Value = serde_json::from_slice(&response).unwrap();
            assert!(
                response["error"].as_str().unwrap().contains("同尺寸"),
                "orientation {orientation}: {response}"
            );
        }
    }
}

const PDF_FIXTURE: &str = r#"
import json, sys
assert open(sys.argv[1], 'rb').read().startswith(b'%PDF-')
assert '--images' in sys.argv[3:]
scans = 1 if sys.argv[2] == 'one-scan.pdf' else 10
records = [{'page': page, 'text': '原生文字页' + str(page)} for page in range(1, 9)]
image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
records += [{'page': 9 + index, 'image': image, 'mime': 'image/png'} for index in range(scans)]
records.append({'page': 9 + scans, 'text': '末尾原生文字仍应保留'})
print(json.dumps(records))
"#;

#[derive(Clone, Default)]
struct VisionCalls(Arc<Mutex<Vec<Value>>>);
async fn vision_fixture(
    State(captured): State<VisionCalls>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert!(headers.get("authorization").is_none());
    assert_eq!(body["model"], "fixture-vision");
    assert!(body["messages"][1]["content"][1]["image_url"]["url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    let mut calls = captured.0.lock().unwrap();
    calls.push(body);
    Json(json!({"choices":[{"message":{"content":format!("扫描页识别内容{}", calls.len())}}]}))
}

#[tokio::test]
async fn native_pdf_pages_do_not_consume_the_eight_visual_page_budget() {
    let mut harness = Harness::new().await;
    let captured = VisionCalls::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let routes = Router::new()
        .route("/chat/completions", post(vision_fixture))
        .with_state(captured.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, routes).await.unwrap();
    });
    let script = harness._directory.path().join("pdf-fixture.py");
    tokio::fs::write(&script, PDF_FIXTURE).await.unwrap();
    let config = Arc::make_mut(&mut harness.state.config);
    config.processor_script = script.to_string_lossy().into();
    config.vision_base_url = base;
    config.vision_model = "fixture-vision".into();
    config.vision_enabled = true;
    // No real service keys are needed: the fixture is reachable only on localhost.
    assert!(config.ai_api_key.is_empty());
    assert!(config.vision_api_key.is_empty());
    assert!(config.chat_api_key.is_empty());
    assert!(config.embedding_api_key.is_empty());
    harness.state.http = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    harness.router = atlas_server::router(harness.state.clone());
    for (name, expected_scans, tail_page) in [("one-scan.pdf", 1, 10), ("capped-scans.pdf", 8, 19)]
    {
        captured.0.lock().unwrap().clear();
        let attachment = harness.upload(name, b"%PDF-1.7 fixture").await;
        let row = harness
            .state
            .db
            .one(
                "SELECT extracted_text FROM studio_inputs WHERE id=?",
                vec![attachment["id"].clone()],
            )
            .await
            .unwrap()
            .unwrap();
        let extracted = s(&row, "extracted_text");
        for page in 1..=8 {
            assert!(extracted.contains(&format!("第 {page} 页：原生文字页{page}")));
        }
        for scan in 1..=expected_scans {
            assert!(extracted.contains(&format!("第 {} 页：扫描页识别内容{scan}", 8 + scan)));
        }
        assert!(extracted.contains(&format!("第 {tail_page} 页：末尾原生文字仍应保留")));
        assert_eq!(captured.0.lock().unwrap().len(), expected_scans);
        if expected_scans == 8 {
            assert!(!extracted.contains("扫描页识别内容9"));
            assert!(!extracted.contains("第 17 页："));
            assert!(!extracted.contains("第 18 页："));
        }
    }
    server.abort();
}
