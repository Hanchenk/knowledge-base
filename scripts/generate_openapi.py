"""Generate the checked-in contract consumed by agents. No runtime Python dependency."""
import json
from pathlib import Path

STRING = {"type": "string"}
INTEGER = {"type": "integer"}
BOOLEAN = {"type": "boolean"}
UUID = {"type": "string", "format": "uuid"}
NULLABLE = {"type": ["string", "null"]}

def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required)}

def arr(item):
    return {"type": "array", "items": item}

schemas = {
    "ModelProviderInput": obj({"enabled": BOOLEAN, "base_url": STRING, "model": STRING, "api_key": {"type": ["string", "null"], "writeOnly": True, "description": "Omit or leave blank to retain saved secret"}, "clear_api_key": BOOLEAN, "dimensions": {"type": "integer", "minimum": 0, "maximum": 2000, "description": "Embedding requires 1..2000; unused for other model types"}}, ["enabled", "base_url", "model"]),
    "MediaModelInput": obj({"id": STRING, "name": {"type": "string", "minLength": 1, "maxLength": 80}, "kind": {"type": "string", "enum": ["image", "video"]}, "config": {"$ref": "#/components/schemas/ModelProviderInput"}}, ["id", "name", "kind", "config"]),
    "MediaModel": obj({"id": STRING, "name": STRING, "kind": {"type": "string", "enum": ["image", "video"]}, "config": {"$ref": "#/components/schemas/ModelProvider"}}),
    "ModelProvider": obj({"enabled": BOOLEAN, "base_url": STRING, "model": STRING, "has_api_key": BOOLEAN, "dimensions": INTEGER}),
    "ModelSettingsInput": obj({"media_models": {"type": "array", "maxItems": 40, "items": {"$ref": "#/components/schemas/MediaModelInput"}}, "default_image_id": NULLABLE, "default_video_id": NULLABLE,"revision": INTEGER, "chat": {"$ref": "#/components/schemas/ModelProviderInput"}, "embedding": {"$ref": "#/components/schemas/ModelProviderInput"}, "vision": {"$ref": "#/components/schemas/ModelProviderInput"}, "image": {"$ref": "#/components/schemas/ModelProviderInput"}, "video": {"$ref": "#/components/schemas/ModelProviderInput"}}, ["revision", "chat", "embedding", "vision"]),
    "ModelSettings": obj({"media_models": arr({"$ref": "#/components/schemas/MediaModel"}), "default_image_id": NULLABLE, "default_video_id": NULLABLE,"revision": INTEGER, "source": {"type": "string", "enum": ["environment", "database"]}, "can_save": BOOLEAN, "postgres_dimensions": {"type": ["integer", "null"]}, "reindex_required": BOOLEAN, "chat": {"$ref": "#/components/schemas/ModelProvider"}, "embedding": {"$ref": "#/components/schemas/ModelProvider"}, "vision": {"$ref": "#/components/schemas/ModelProvider"}, "image": {"$ref": "#/components/schemas/ModelProvider"}, "video": {"$ref": "#/components/schemas/ModelProvider"}}),
    "ModelTestInput": obj({"config_id": {"type":"string", "description":"Media profile ID; omit for legacy default provider. New UUID rows do not inherit any saved key."},"kind": {"type": "string", "enum": ["chat", "embedding", "vision", "image", "video"]}, "revision": INTEGER, "config": {"$ref": "#/components/schemas/ModelProviderInput"}}, ["kind", "revision", "config"]),
    "ModelTestResult": obj({"success": BOOLEAN, "message": STRING, "latency_ms": INTEGER, "dimensions": {"type": ["integer", "null"]}}),
    "Login": obj({"tenant": STRING, "email": STRING, "password": STRING}, ["tenant", "email", "password"]),
    "Search": obj({"query": {"type": "string", "maxLength": 2000}, "space_id": NULLABLE, "document_ids": {"type": "array", "items": UUID, "minItems": 1, "maxItems": 10, "description": "Restrict search to authorized, fully indexed attachments"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}, "image_base64": NULLABLE, "image_mime": {"type": "string", "enum": ["image/png", "image/jpeg", "image/webp"]}}),
    "Chat": obj({"query": {"type": "string", "maxLength": 2000}, "space_id": NULLABLE, "document_ids": {"type": "array", "items": UUID, "minItems": 1, "maxItems": 10, "description": "Answer using these authorized, fully indexed attachments; knowledge tools stay within this selection"}, "conversation_id": NULLABLE, "allow_web": {"type": "boolean", "default": False, "description": "Allow Pi Agent to use public web tools for this turn; also subject to administrator AGENT_WEB_ENABLED policy"}, "image_base64": NULLABLE, "image_mime": STRING}),
    "TextDocument": obj({"space_id": UUID, "title": STRING, "content": STRING, "tags": arr(STRING)}, ["space_id", "title", "content"]),
    "Space": obj({"name": STRING, "description": STRING, "color": {"type": "string", "enum": ["blue", "purple", "green", "orange"]}}, ["name"]),
    "Grant": obj({"principal_type": {"type": "string", "enum": ["tenant", "department", "user", "reports"]}, "principal_id": UUID, "include_descendants": BOOLEAN, "can_view": BOOLEAN, "can_create": BOOLEAN, "can_manage": BOOLEAN, "effect": {"type": "string", "enum": ["allow", "deny"]}}, ["principal_type", "principal_id"]),
    "UserCreate": obj({"email": STRING, "name": STRING, "password": {"type": "string", "minLength": 1, "maxLength": 128}, "department_id": NULLABLE, "manager_id": NULLABLE, "role": {"type": "string", "enum": ["member", "admin"]}}, ["email", "name", "password"]),
    "UserUpdate": obj({"name": STRING, "password": {"type": "string", "minLength": 1, "maxLength": 128}, "department_id": NULLABLE, "manager_id": NULLABLE, "role": {"type": "string", "enum": ["member", "admin"]}, "active": BOOLEAN}, ["name", "role", "active"]),
    "Department": obj({"name": STRING, "parent_id": NULLABLE}, ["name"]),
    "ApiKey": obj({"name": STRING, "scopes": arr({"type": "string", "enum": ["search.read", "document.read", "document.write"]}), "expires_days": {"type": "integer", "minimum": 1, "maximum": 365, "default": 30}}, ["name", "scopes"]),
    "Citation": obj({"chunk_id": UUID, "citation_number": INTEGER, "referenced": BOOLEAN, "document_id": UUID, "space_id": UUID, "title": STRING, "text": STRING, "page": INTEGER, "kind": {"type": "string", "enum": ["text", "table", "table_summary", "image"]}, "image_url": NULLABLE, "source_url": STRING, "version": INTEGER, "score": {"type": "number"}}, ["chunk_id", "document_id", "title", "text", "page"]),
    "SearchResult": obj({"query": STRING, "mode": {"type": "string", "enum": ["keyword", "hybrid"]}, "hits": arr({"$ref": "#/components/schemas/Citation"}), "warnings": arr(STRING)}),
    "WebSource": obj({"citation_number": INTEGER, "referenced": BOOLEAN, "title": STRING, "url": {"type": "string", "format": "uri"}}),
    "ToolCall": obj({"name": STRING, "success": BOOLEAN, "duration_ms": INTEGER}),
    "ChatResult": obj({"answer": STRING, "citations": arr({"$ref": "#/components/schemas/Citation"}), "warnings": arr(STRING), "mode": STRING, "conversation_id": NULLABLE, "engine": {"type": "string", "enum": ["pi-agent-core", "direct-rag", "excerpts"]}, "web_sources": arr({"$ref": "#/components/schemas/WebSource"}), "tool_calls": arr({"$ref": "#/components/schemas/ToolCall"})}),
    "StudioProjectInput": obj({"title": STRING}, ["title"]),
    "StudioChatInput": obj({"image_model_id": {"type":"string", "description":"Enabled image profile from own tenant capability catalog; omit for default"}, "video_model_id": {"type":"string", "description":"Enabled video profile from own tenant capability catalog; omit for default"},"project_id": UUID, "request_id": UUID, "prompt": {"type": "string", "minLength": 1, "maxLength": 4000}, "kind": {"type": "string", "enum": ["image", "video", "auto"]}, "image_size": {"type": "string", "enum": ["1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"]}, "video_size": {"type": "string", "enum": ["1280x720", "720x1280"]}, "seconds": {"type": "integer", "enum": [4, 8, 12]}, "allow_web": {"type": "boolean", "default": False}}, ["project_id", "request_id", "prompt", "kind", "image_size", "video_size", "seconds"]),
    "StudioProject": obj({"id": UUID, "title": STRING, "created_at": INTEGER, "updated_at": INTEGER}),
    "StudioJob": obj({"id": UUID, "kind": {"type": "string", "enum": ["image", "video"]}, "prompt": STRING, "model": STRING, "size": STRING, "seconds": INTEGER, "status": {"type": "string", "enum": ["queued", "running", "completed", "failed"]}, "progress": INTEGER, "error": NULLABLE, "created_at": INTEGER, "finished_at": {"type": ["integer", "null"]}}),
    "StudioAsset": obj({"id": UUID, "job_id": UUID, "kind": STRING, "mime_type": STRING, "size": INTEGER, "created_at": INTEGER}),
    "Error": obj({"error": STRING}),
}
schemas.update({
    "BotOptions": obj({"allow_web": BOOLEAN, "allow_code": BOOLEAN, "connector_ids": {"type": "array", "maxItems": 10, "items": UUID}, "skill_ids": {"type": "array", "maxItems": 5, "items": STRING}, "document_ids": {"type": "array", "maxItems": 10, "items": UUID}, "parent_task_id": NULLABLE, "local_device_id": NULLABLE}),
    "BotTaskInput": obj({"request_id": UUID, "prompt": {"type": "string", "minLength": 1, "maxLength": 6000}, "options": {"$ref": "#/components/schemas/BotOptions"}}, ["request_id", "prompt"]),
    "BotConnectorInput": obj({"name": {"type": "string", "minLength": 1, "maxLength": 60}, "description": {"type": "string", "maxLength": 500}, "url": {"type": "string", "format": "uri"}, "method": {"type": "string", "enum": ["GET", "POST"]}, "token": {"type": "string", "writeOnly": True, "maxLength": 4096}}, ["name", "url", "method"]),
    "BotSkillInput": obj({"name": {"type": "string", "minLength": 1, "maxLength": 60}, "description": {"type": "string", "maxLength": 500}, "instructions": {"type": "string", "minLength": 1, "maxLength": 12000}}, ["name", "instructions"]),
})
paths = {}

def endpoint(path, method, summary, body=None, response=None, queries=(), public=False, browser=False):
    operation = {"operationId": method + '_' + path.strip('/').replace('/', '_').replace('{id}', 'by_id'), "summary": summary, "security": [] if public else ([{"sessionCookie": []}] if browser else [{"bearerAuth": []}, {"sessionCookie": []}]), "responses": {"200": {"description": "Success", "content": {"application/json": {"schema": response or {"type": "object"}}}}, "400": {"description": "Invalid request"}, "401": {"description": "Authentication required"}, "403": {"description": "Current ACL or key scope forbids access"}, "404": {"description": "Resource unavailable"}}}
    parameters = []
    if '{id}' in path:
        parameters.append({"name": "id", "in": "path", "required": True, "schema": UUID})
    for name, schema in queries:
        parameters.append({"name": name, "in": "query", "schema": schema})
    if parameters:
        operation["parameters"] = parameters
    if body:
        operation["requestBody"] = {"required": True, "content": {"application/json": {"schema": {"$ref": '#/components/schemas/' + body} if isinstance(body, str) else body}}}
    if browser and method != 'get':
        operation.setdefault('parameters', []).append({"name": "Origin", "in": "header", "required": True, "schema": STRING, "description": "Trusted browser origin configured in CORS_ORIGINS or PUBLIC_URL"})
    paths.setdefault(path, {})[method] = operation

endpoint('/api/bot/devices', 'get', 'List this account paired local execution devices', browser=True)
endpoint('/api/bot/devices/{id}', 'delete', 'Revoke device and cancel unfinished platform tasks', browser=True)
endpoint('/api/bot/pairings', 'post', 'Create a single-use ten-minute Desktop pairing code', obj({}), browser=True)
endpoint('/api/bot/local/pair', 'post', 'Pair Desktop using a browser-issued code and Desktop-minted secret', obj({"code": STRING, "token": {"type": "string", "writeOnly": True}, "name": STRING, "workspace_id": STRING, "workspace_title": STRING}, ['code', 'token', 'name', 'workspace_id', 'workspace_title']), public=True)
endpoint('/api/bot/local/connections', 'post', 'Begin browser-confirmed Desktop connection without a manual pairing code', obj({"token": {"type": "string", "writeOnly": True}, "name": STRING, "workspace_id": STRING, "workspace_title": STRING}, ['token', 'name', 'workspace_id', 'workspace_title']), public=True)
endpoint('/api/bot/local/connections/poll', 'post', 'Retrieve approval with the Desktop-held credential', obj({"id": UUID, "token": {"type": "string", "writeOnly": True}}, ['id', 'token']), public=True)
endpoint('/api/bot/local/connections/cancel', 'post', 'Cancel the credential-holder connection and revoke any approved device', obj({"token": {"type": "string", "writeOnly": True}}, ['token']), public=True)
endpoint('/api/bot/connections/{id}', 'get', 'Read pending computer and workspace for browser approval', browser=True)
endpoint('/api/bot/connections/{id}/approve', 'post', 'Bind Desktop to the signed-in browser account', obj({}), browser=True)
for route, summary, body in [
    ('poll', 'Device heartbeat and command retrieval', obj({})),
    ('disconnect', 'Revoke the calling device', obj({})),
    ('import', 'Import a native Desktop turn without execution', obj({"session_id": STRING, "turn_key": STRING, "request_id": UUID, "prompt": STRING, "title": STRING}, ['session_id', 'turn_key', 'request_id', 'prompt', 'title'])),
    ('tasks/{id}/start', 'Bind and acknowledge one native session', obj({"session_id": STRING}, ['session_id'])),
    ('tasks/{id}/sync', 'Acknowledge an immutable ordered public execution snapshot', obj({"seq": INTEGER, "turn_key": STRING, "status": STRING, "result": STRING, "messages": arr(obj({"id": UUID, "content": STRING, "status": STRING, "created_at": INTEGER}, ['id', 'content', 'status', 'created_at'])), "events": arr(obj({"id": UUID, "name": STRING, "success": BOOLEAN, "created_at": INTEGER}, ['id', 'name', 'success', 'created_at'])), "error": NULLABLE}, ['seq', 'turn_key', 'status', 'result'])),
    ('tasks/{id}/cancel-ack', 'Acknowledge native cancellation', obj({})),
    ('tasks/{id}/tool', 'Execute an assigned task authorized platform tool', obj({"name": STRING, "args": obj({})}, ['name', 'args'])),
]:
    endpoint('/api/bot/local/' + route, 'post', summary, body)
    paths['/api/bot/local/' + route]['post']['security'] = [{"desktopDevice": []}]
endpoint('/api/bot/capabilities', 'get', 'Actual bot model, web and isolated Python capabilities', browser=True)
endpoint('/api/bot/tasks', 'get', 'List own persisted bot tasks', response=arr({"type": "object"}), browser=True)
endpoint('/api/bot/tasks', 'post', 'Submit idempotent bot task or follow-up with selected tools', 'BotTaskInput', browser=True)
endpoint('/api/bot/tasks/{id}', 'get', 'Own task, persisted public messages, evidence-filtered results, plan, events, actions and artifacts', browser=True)
endpoint('/api/bot/tasks/{id}/stream', 'get', 'Stream own task and public assistant text with current authorization checks', browser=True)
paths['/api/bot/tasks/{id}/stream']['get']['responses']['200'] = {
    "description": "SSE: snapshot carries the complete task detail, output carries {id,text,replace,status,created_at}; end closes completed/waiting tasks, unavailable closes access changes. Reconnect restores a snapshot. Thinking and tool arguments are excluded.",
    "content": {"text/event-stream": {"schema": STRING}},
    "headers": {"X-Accel-Buffering": {"schema": {"type": "string", "enum": ["no"]}}},
}
endpoint('/api/bot/tasks/{id}/cancel', 'post', 'Cancel own queued, running or waiting task', browser=True)
endpoint('/api/bot/tasks/{id}/retry', 'post', 'Retry own failed or cancelled task; external writes stay deduplicated', browser=True)
endpoint('/api/bot/artifacts/{id}', 'get', 'Download private task artifact after current evidence authorization check', browser=True)
paths['/api/bot/artifacts/{id}']['get']['responses']['200'] = {"description": "Download attachment", "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}
endpoint('/api/bot/connectors', 'get', 'List own connectors without decrypted credentials', response=arr({"type": "object"}), browser=True)
endpoint('/api/bot/connectors', 'post', 'Create encrypted connector constrained to deployment host allowlist', 'BotConnectorInput', browser=True)
endpoint('/api/bot/connectors/{id}', 'delete', 'Disable own connector', browser=True)
endpoint('/api/bot/connectors/{id}/test', 'post', 'Test GET connection; validate POST without sending a write', browser=True)
endpoint('/api/bot/actions/{id}/approve', 'post', 'Approve and execute exact persisted POST once, then resume task', browser=True)
endpoint('/api/bot/actions/{id}/reject', 'post', 'Reject persisted operation and resume own task', browser=True)
endpoint('/api/bot/skills', 'get', 'List builtin and own imported workflow skills', response=arr({"type": "object"}), browser=True)
endpoint('/api/bot/skills', 'post', 'Create private workflow skill; no script execution', 'BotSkillInput', browser=True)
endpoint('/api/bot/skills/{id}', 'delete', 'Delete own imported skill without altering task snapshots', browser=True)
endpoint('/api/auth/login', 'post', 'Log in to a tenant and receive an HttpOnly session', 'Login', public=True)
endpoint('/api/auth/logout', 'post', 'Revoke the current session', browser=True)
endpoint('/api/auth/me', 'get', 'Current user and tenant')
endpoint('/api/public-config', 'get', 'Public demo and SSO availability', public=True)
endpoint('/api/health', 'get', 'Database readiness', public=True)
endpoint('/api/search', 'post', 'Permission-filtered hybrid text/image search (search.read)', 'Search', {"$ref": '#/components/schemas/SearchResult'})
endpoint('/api/chat', 'post', 'Pi Agent knowledge answer with authorized tools, optional public web search and citations (search.read)', 'Chat', {"$ref": '#/components/schemas/ChatResult'})
endpoint('/api/spaces', 'get', 'List accessible knowledge spaces (search.read)', response=arr({"type": "object"}))
endpoint('/api/spaces', 'post', 'Create a knowledge space (tenant admin)', 'Space', browser=True)
endpoint('/api/spaces/{id}/grants', 'get', 'Get space ACL (space manager)', response=arr({"$ref": '#/components/schemas/Grant'}), browser=True)
endpoint('/api/spaces/{id}/grants', 'put', 'Replace space ACL (space manager)', arr({"$ref": '#/components/schemas/Grant'}), browser=True)
endpoint('/api/principals', 'get', 'List eligible grant principals (space manager)', queries=[('space_id', UUID)], browser=True)
endpoint('/api/organization', 'get', 'Tenant departments and members (tenant admin)', browser=True)
endpoint('/api/users', 'post', 'Create a member (tenant admin)', 'UserCreate', browser=True)
endpoint('/api/users/{id}', 'put', 'Update role, hierarchy or password; invalidate sessions when necessary (tenant admin)', 'UserUpdate', browser=True)
endpoint('/api/departments', 'post', 'Create a department (tenant admin)', 'Department', browser=True)
endpoint('/api/departments/{id}', 'put', 'Update department hierarchy (tenant admin)', 'Department', browser=True)
endpoint('/api/documents', 'get', 'List authorized documents (document.read)', queries=[('space_id', UUID), ('q', STRING), ('limit', INTEGER), ('offset', INTEGER)])
endpoint('/api/documents', 'post', 'Create a Markdown document and queue indexing (document.write)', 'TextDocument')
endpoint('/api/documents/upload', 'post', 'Upload a file or new version (document.write)')
paths['/api/documents/upload']['post']['requestBody'] = {"required": True, "content": {"multipart/form-data": {"schema": obj({"space_id": UUID, "title": STRING, "replace_id": UUID, "file": {"type": "string", "format": "binary"}}, ['file']), "encoding": {"file": {"contentType": "application/octet-stream"}}}}}
paths['/api/documents/upload']['post']['description'] = 'Max 500 MB (524288000 bytes) per file; max multipart request 502 MB. space_id is required for a new document. replace_id selects an existing document; space_id is ignored when replacing. Creation requires can_create. Replacing requires can_view and can_create plus ownership or can_manage.'
paths['/api/documents/upload']['post']['responses']['413'] = {"description": "File exceeds 500 MB or multipart request exceeds 502 MB"}
endpoint('/api/documents/{id}', 'get', 'Read document and indexed chunks (document.read)')
endpoint('/api/documents/{id}', 'delete', 'Soft-delete document and remove retrieval chunks (document.write)')
endpoint('/api/documents/{id}/status', 'get', 'Permission-checked lightweight indexing status (document.read)', response=obj({'id': UUID, 'status': STRING, 'error': NULLABLE, 'version': INTEGER, 'indexed_version': INTEGER}))
endpoint('/api/documents/{id}/retry', 'post', 'Queue reindexing (document.write)')
endpoint('/api/documents/{id}/versions', 'get', 'List source versions (document.read)', response=arr({"type": "object"}))
endpoint('/api/documents/{id}/file', 'get', 'Download an authorized source version (document.read)', queries=[('version', INTEGER)])
paths['/api/documents/{id}/file']['get']['responses']['200'] = {"description": "File attachment", "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}
endpoint('/api/chunks/{id}/image', 'get', 'View an authorized extracted image (document.read)')
paths['/api/chunks/{id}/image']['get']['responses']['200'] = {"description": "JPEG preview", "content": {"image/jpeg": {"schema": {"type": "string", "format": "binary"}}}}
endpoint('/api/keys', 'get', 'List own API keys (secrets never returned)', response=arr({"type": "object"}), browser=True)
endpoint('/api/keys', 'post', 'Create scoped API key; full secret returned once', 'ApiKey', browser=True)
endpoint('/api/keys/{id}', 'delete', 'Immediately revoke own API key', browser=True)
endpoint('/api/stats', 'get', 'Authorized knowledge counts and configured capabilities', browser=True)
schemas['StorageInput'] = obj({'enabled': BOOLEAN, 'revision': INTEGER, 'endpoint': STRING, 'bucket': STRING, 'access_key': STRING, 'secret_key': {'type': ['string', 'null'], 'writeOnly': True, 'description': 'Blank retains saved secret'}, 'region': STRING}, ['enabled', 'revision', 'endpoint', 'bucket', 'access_key', 'region'])
endpoint('/api/settings/storage', 'get', 'Read MinIO configuration; never returns secret key (tenant admin)', browser=True)
endpoint('/api/settings/storage', 'put', 'Save encrypted MinIO configuration; new files use it immediately, existing locations retained', 'StorageInput', browser=True)
endpoint('/api/settings/storage/test', 'post', 'Test MinIO upload/read/delete without saving', 'StorageInput', browser=True)
schemas['PersonalPreferences'] = obj({'auto_archive': BOOLEAN}, ['auto_archive'])
endpoint('/api/personal/preferences', 'get', 'Read own automatic studio archive preference and personal space ID', browser=True)
endpoint('/api/personal/preferences', 'put', 'Set automatic archiving of newly completed media to own private knowledge space', 'PersonalPreferences', browser=True)
endpoint('/api/models', 'get', 'Read tenant model configuration; secrets never returned (tenant admin)', response={"$ref": "#/components/schemas/ModelSettings"}, browser=True)
endpoint('/api/models', 'put', 'Save encrypted tenant model configuration; takes effect without restart (tenant admin)', 'ModelSettingsInput', {"$ref": "#/components/schemas/ModelSettings"}, browser=True)
endpoint('/api/models/test', 'post', 'Probe RAG inference or media model-list connectivity; never saves or generates media (tenant admin)', 'ModelTestInput', {"$ref": "#/components/schemas/ModelTestResult"}, browser=True)
endpoint('/api/models/discover', 'post', 'Discover provider model IDs from GET /models; never saves (tenant admin)', 'ModelTestInput', obj({'models': arr(STRING), 'message': STRING}), browser=True)
for path in ['/api/models', '/api/models/test', '/api/models/discover']:
    for operation in paths[path].values():
        operation['responses']['409'] = {"description": "Configuration revision changed; reload before saving or testing"}
endpoint('/api/studio/capabilities', 'get', 'Own tenant creative capabilities; no keys or provider addresses', browser=True)
endpoint('/api/studio/projects', 'get', 'Own latest 50 creative projects', response=arr({"$ref": '#/components/schemas/StudioProject'}), browser=True)
endpoint('/api/studio/projects', 'post', 'Create a private creative project', 'StudioProjectInput', browser=True)
endpoint('/api/studio/projects/{id}', 'get', 'Read own project, authorized messages, jobs and media metadata', response=obj({'project': {"$ref": '#/components/schemas/StudioProject'}, 'messages': arr({"type": "object"}), 'jobs': arr({"$ref": '#/components/schemas/StudioJob'}), 'assets': arr({"$ref": '#/components/schemas/StudioAsset'})}), browser=True)
endpoint('/api/studio/chat', 'post', 'Pi Agent plans creation and queues image/video tools; request_id deduplicates each media type', 'StudioChatInput', obj({'answer': STRING, 'engine': {"const": "pi-agent-core"}, 'project_id': UUID}), browser=True)
paths['/api/studio/chat']['post']['responses']['429'] = {"description": "Concurrent creative task limit reached"}
endpoint('/api/studio/assets/{id}', 'get', 'Read own generated image/video; supports single byte range', browser=True)
asset_operation = paths['/api/studio/assets/{id}']['get']
asset_operation.setdefault('parameters', []).append({'name': 'Range', 'in': 'header', 'schema': STRING, 'description': 'Single byte range, e.g. bytes=0-1023'})
asset_operation['responses']['200'] = {'description': 'Private generated media', 'content': {mime: {'schema': {'type': 'string', 'format': 'binary'}} for mime in ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']}}
asset_operation['responses']['206'] = {'description': 'Partial media content', 'headers': {'Content-Range': {'schema': STRING}}, 'content': asset_operation['responses']['200']['content']}
asset_operation['responses']['416'] = {'description': 'Unsatisfiable byte range'}
endpoint('/api/audit', 'get', 'Paginated tenant audit events (tenant admin)', queries=[('limit', INTEGER), ('offset', INTEGER)], response=arr({"type": "object"}), browser=True)
endpoint('/api/jobs', 'get', 'Latest 100 durable indexing jobs (tenant admin)', response=arr({"type": "object"}), browser=True)
endpoint('/api/conversations', 'get', 'Own latest conversations', response=arr({"type": "object"}), browser=True)
endpoint('/api/conversations/{id}/messages', 'get', 'Own messages; redact answers referencing inaccessible or changed sources', response=arr({"type": "object"}), browser=True)
spec = {"openapi": "3.1.0", "info": {"title": "知汇 Atlas Enterprise Knowledge API", "version": "0.1.0", "description": "All retrieval, citations, downloads and mutations enforce current tenant and space permissions. API keys inherit the owner's live rights and restrict operations through scopes. Timestamps are Unix milliseconds."}, "servers": [{"url": "/"}], "paths": paths, "components": {"securitySchemes": {"desktopDevice": {"type": "http", "scheme": "bearer", "description": "Account-bound zd_ device credential, only /api/bot/local endpoints"}, "bearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "ak_..."}, "sessionCookie": {"type": "apiKey", "in": "cookie", "name": "atlas_session"}}, "schemas": schemas}}
Path('docs/openapi.json').write_text(json.dumps(spec, ensure_ascii=False, indent=2) + '\n')

