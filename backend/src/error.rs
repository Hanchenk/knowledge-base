use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String);
pub type Result<T> = std::result::Result<T, AppError>;
impl AppError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
    pub fn unauthorized() -> Self {
        Self(
            StatusCode::UNAUTHORIZED,
            "请先登录或提供有效的 API Key".into(),
        )
    }
    pub fn forbidden() -> Self {
        Self(StatusCode::FORBIDDEN, "没有执行此操作的权限".into())
    }
    pub fn missing() -> Self {
        Self(StatusCode::NOT_FOUND, "资源不存在或不可访问".into())
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let unauthorized = self.0 == StatusCode::UNAUTHORIZED;
        let mut response = (self.0, Json(json!({"error":self.1}))).into_response();
        if unauthorized {
            response.headers_mut().insert(
                axum::http::header::WWW_AUTHENTICATE,
                axum::http::HeaderValue::from_static("Bearer realm=\"atlas\""),
            );
        }
        response
    }
}
impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        tracing::error!(error = %error, "operation failed");
        if let Some(sqlx::Error::Database(database)) = error.downcast_ref::<sqlx::Error>() {
            if matches!(database.code().as_deref(), Some("13" | "53100")) {
                return Self(
                    StatusCode::INSUFFICIENT_STORAGE,
                    "数据库存储空间不足，请释放应用所在磁盘的空间后重试".into(),
                );
            }
        }
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "操作失败，请查看服务日志或联系管理员".into(),
        )
    }
}
impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        anyhow::Error::from(error).into()
    }
}
