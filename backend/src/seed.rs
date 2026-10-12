use crate::{
    auth::{password_hash, validate_password},
    db::{id, now},
    documents::{self, TextInput},
    AppState,
};
use serde_json::json;

pub async fn initialize(state: &AppState) -> anyhow::Result<()> {
    if state.config.seed_demo {
        demo(state).await?;
    }
    let slug = std::env::var("BOOTSTRAP_TENANT_SLUG").unwrap_or_default();
    if !slug.is_empty()
        && state
            .db
            .one("SELECT id FROM tenants WHERE slug=?", vec![json!(slug)])
            .await?
            .is_none()
    {
        let email = std::env::var("BOOTSTRAP_ADMIN_EMAIL")?
            .trim()
            .to_lowercase();
        let password = std::env::var("BOOTSTRAP_ADMIN_PASSWORD")?;
        validate_password(&password).map_err(|e| anyhow::anyhow!(e.1))?;
        anyhow::ensure!(email.contains('@'), "BOOTSTRAP_ADMIN_EMAIL is invalid");
        let name = std::env::var("BOOTSTRAP_TENANT_NAME").unwrap_or_else(|_| slug.clone());
        let tenant = id();
        let user = id();
        let saved = password_hash(&password)?;
        let mut tx = state.db.pool.begin().await?;
        state
            .db
            .tx_exec(
                &mut tx,
                "INSERT INTO tenants(id,slug,name) VALUES(?,?,?)",
                vec![json!(tenant), json!(slug), json!(name)],
            )
            .await?;
        state.db.tx_exec(&mut tx,"INSERT INTO users(id,tenant_id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,'admin',?)",vec![json!(user),json!(tenant),json!(email),json!("企业管理员"),json!(saved),json!(now())]).await?;
        tx.commit().await?;
    }
    Ok(())
}
async fn demo(state: &AppState) -> anyhow::Result<()> {
    if state
        .db
        .one("SELECT id FROM tenants WHERE slug='atlas'", vec![])
        .await?
        .is_some()
    {
        return Ok(());
    }
    let tenant = id();
    let admin = id();
    let eng = id();
    let product = id();
    let hr = id();
    let sales = id();
    let lead = id();
    let member = id();
    let hr_user = id();
    let saved = password_hash("AtlasDemo123!")?;
    let mut tx = state.db.pool.begin().await?;
    state
        .db
        .tx_exec(
            &mut tx,
            "INSERT INTO tenants(id,slug,name) VALUES(?,'atlas','知汇示例企业')",
            vec![json!(tenant)],
        )
        .await?;
    for (key, name, parent) in [
        (&eng, "产品研发中心", None),
        (&product, "产品部", Some(&eng)),
        (&hr, "人力行政部", None),
        (&sales, "市场客户部", None),
    ] {
        state
            .db
            .tx_exec(
                &mut tx,
                "INSERT INTO departments(id,tenant_id,name,parent_id) VALUES(?,?,?,?)",
                vec![json!(key), json!(tenant), json!(name), json!(parent)],
            )
            .await?;
    }
    for (key, name, email, department, manager, role) in [
        (&admin, "陈知远", "admin@atlas.local", None, None, "admin"),
        (
            &lead,
            "林沐",
            "lin@atlas.local",
            Some(&eng),
            Some(&admin),
            "member",
        ),
        (
            &member,
            "王晨",
            "wang@atlas.local",
            Some(&product),
            Some(&lead),
            "member",
        ),
        (
            &hr_user,
            "周宁",
            "zhou@atlas.local",
            Some(&hr),
            Some(&admin),
            "member",
        ),
    ] {
        state.db.tx_exec(&mut tx,"INSERT INTO users(id,tenant_id,email,name,password_hash,department_id,manager_id,role,created_at) VALUES(?,?,?,?,?,?,?,?,?)",vec![json!(key),json!(tenant),json!(email),json!(name),json!(saved),json!(department),json!(manager),json!(role),json!(now())]).await?;
    }
    let mut spaces = Vec::new();
    for (name, description, color, principal_type, principal) in [
        (
            "全员知识",
            "每个人都用得上的制度、流程与工作指南",
            "blue",
            "tenant",
            &tenant,
        ),
        (
            "产品与研发",
            "让产品决策与工程经验持续沉淀",
            "purple",
            "department",
            &eng,
        ),
        (
            "人力与行政",
            "组织制度、人才发展与行政服务",
            "green",
            "department",
            &hr,
        ),
        (
            "市场与客户",
            "连接客户洞察、品牌策略与业务增长",
            "orange",
            "department",
            &sales,
        ),
    ] {
        let space = id();
        state.db.tx_exec(&mut tx,"INSERT INTO spaces(id,tenant_id,name,description,color,created_by,created_at) VALUES(?,?,?,?,?,?,?)",vec![json!(space),json!(tenant),json!(name),json!(description),json!(color),json!(admin),json!(now())]).await?;
        state.db.tx_exec(&mut tx,"INSERT INTO grants(id,space_id,principal_type,principal_id,include_descendants,can_view,can_create) VALUES(?,?,?,?,1,1,1)",vec![json!(id()),json!(space),json!(principal_type),json!(principal)]).await?;
        spaces.push(space);
    }
    tx.commit().await?;
    let actor = crate::auth::Actor {
        id: admin,
        tenant_id: tenant,
        department_id: String::new(),
        role: "admin".into(),
        scopes: None,
        key_id: None,
    };
    let examples=[
        (0,"差旅与费用报销指南", "# 差旅与费用报销指南\n\n> 示例资料，请以企业实际制度为准。\n\n## 报销流程\n员工应在出差结束后 15 个工作日内提交报销申请。先在费用系统填写申请，上传发票、行程单及付款凭证，直属上级审核后由财务复核。审批完成后 5 个工作日内付款。\n\n## 住宿标准\n一线城市住宿标准为每晚 600 元，其他城市每晚 400 元。超出标准需在出行前取得部门负责人审批。高铁可选择二等座，机票优先经济舱。\n\n## 注意事项\n发票抬头须为企业全称，个人消费不能报销。"),
        (0,"新同事入职手册", "# 新同事入职手册\n\n> 示例资料。\n\n入职第一天由人力同事协助办理工牌、开通企业邮箱和工作账号。直属上级会安排导师。第一周完成安全培训、了解部门目标和知识库使用方法。试用期为三个月，第一个月末进行目标回顾。\n\n知识库用于沉淀经验。敏感信息应存入受限的部门空间，勿在公共空间上传客户个人信息或账号密码。"),
        (0,"企业知识管理规范", "# 企业知识管理规范\n\n> 示例资料。\n\n知识应有明确负责人、适用范围和更新时间。每季度由空间管理员检查过期内容。使用标题、标签和结构化段落提升检索质量。\n\nAI 回答应检查原文引用。上传图片后，视觉模型会提取可见文字、图表及流程信息；检索结果可返回原图，便于核对。没有证据时不得把推测作为企业制度。"),
        (1,"产品需求评审流程", "# 产品需求评审流程\n\n> 示例资料。\n\n产品经理提交需求说明，包含用户问题、目标指标、交互方案、验收标准和风险评估。评审由产品、设计、研发和测试共同参与。需求通过后进入排期，负责人明确里程碑。\n\nP0 需求涉及核心业务阻塞，需要当天组织评审。普通需求每周三评审，会上记录决策依据与未解决问题。"),
        (1,"工程发布与回滚规范", "# 工程发布与回滚规范\n\n> 示例资料。\n\n生产发布需通过代码评审、自动化测试和预发验证。发布采用灰度策略：先覆盖 5% 流量，观察 15 分钟，指标正常后逐步扩大。错误率超过 1% 或 P99 延迟超过基线两倍时停止发布并回滚。\n\n数据库迁移必须兼容旧版本，回滚前确认数据兼容性。每次发布登记版本、变更说明、负责人及回滚方案。"),
        (1,"设计系统使用指南", "# 设计系统使用指南\n\n> 示例资料。\n\n界面使用统一的 8px 间距系统、清晰的标题层级和足够的色彩对比度。危险操作需二次确认。所有表单提供可见标签和错误说明。\n\n组件先复用已有规范。新组件在设计评审后加入设计系统，并提供键盘操作与移动端适配。"),
        (2,"人才培养与绩效制度", "# 人才培养与绩效制度\n\n> 部门受限示例资料。\n\n绩效周期为季度。直属上级与员工共同约定目标，每月回顾进展。评价参考结果、协作与能力成长，校准会议限人力和授权管理者参加。\n\n每位员工每年可申请 3000 元培训预算，需上级审批及培训总结。"),
        (3,"客户访谈与洞察模板", "# 客户访谈与洞察模板\n\n> 部门受限示例资料。\n\n访谈应记录客户业务场景、现有流程、关键痛点、决策因素与预期价值。开放式提问，避免引导结论。录音必须事先获得同意。\n\n访谈后 48 小时内整理纪要，将事实、观察与假设区分记录。客户隐私信息只存于受限空间。"),
    ];
    for (space, title, content) in examples {
        documents::text(
            state,
            &actor,
            TextInput {
                space_id: spaces[space].clone(),
                title: title.into(),
                content: content.into(),
                tags: vec!["示例".into()],
            },
        )
        .await
        .map_err(|e| anyhow::anyhow!(e.1))?;
    }
    tracing::info!("Demo tenant initialized. Login: atlas / admin@atlas.local / AtlasDemo123!");
    Ok(())
}
