import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Download,
  ExternalLink,
  Globe2,
  Loader2,
  Package,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { Modal } from "./components";
import { BotPluginConfig } from "./BotPluginConfig";
import type { Feedback } from "./App";
import {
  harnessApi,
  type HarnessCatalog,
  type HarnessPlugin,
} from "./harness-api";
import "./bot-plugins.css";

type Props = {
  available: boolean;
  catalog?: HarnessCatalog;
  loading: boolean;
  error: string;
  pluginIds: string[];
  local: boolean;
  onPlugins: (ids: string[]) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  feedback: Feedback;
};

type Tab = "market" | "installed" | "sources";

function publicUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function updateSource(plugin: HarnessPlugin) {
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[^/\s]+)?$/i.test(plugin.source)
    ? plugin.id
    : plugin.source || plugin.id;
}

export function BotPlugins({
  available,
  catalog,
  loading,
  error,
  pluginIds,
  local,
  onPlugins,
  onRefresh,
  onClose,
  feedback,
}: Props) {
  const [tab, setTab] = useState<Tab>("market");
  const [query, setQuery] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<HarnessCatalog>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [removeId, setRemoveId] = useState("");
  const [configPlugin, setConfigPlugin] = useState<HarnessPlugin>();

  useEffect(() => {
    if (tab !== "market") return;
    if (!query.trim() && !marketplace) {
      setResults(undefined);
      setSearching(false);
      setSearchError("");
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setSearchError("");
    const timer = window.setTimeout(() => {
      void harnessApi
        .catalog(query, marketplace, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setResults(value);
        })
        .catch((reason: Error) => {
          if (!controller.signal.aborted) {
            setResults(undefined);
            setSearchError(reason.message);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, marketplace, tab]);

  const installed = catalog?.plugins.filter((plugin) => plugin.installed) || [];
  const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
  const marketPlugins =
    (results || catalog)?.plugins.map(
      (plugin) => installedById.get(plugin.id) || plugin,
    ) || [];
  const categories = useMemo(
    () =>
      [
        ...new Set((catalog?.plugins || []).map((plugin) => plugin.category)),
      ].filter(Boolean),
    [catalog],
  );
  const visible = (tab === "installed" ? installed : marketPlugins).filter(
    (plugin) =>
      (!category || plugin.category === category) &&
      (tab === "market" ||
        `${plugin.name} ${plugin.id} ${plugin.description}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    message: string,
  ) => {
    if (busy) return;
    setBusy(key);
    setActionError("");
    try {
      await action();
      await onRefresh();
      if (tab === "market" && (query.trim() || marketplace))
        setResults(await harnessApi.catalog(query, marketplace));
      feedback(message);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      feedback(message, true);
    } finally {
      setBusy("");
    }
  };

  const select = (plugin: HarnessPlugin) => {
    if (!plugin.installed || !plugin.enabled || local || !available) return;
    const selected = pluginIds.includes(plugin.id);
    if (!selected && pluginIds.length >= 20) {
      feedback("一个任务最多选择 20 个插件", true);
      return;
    }
    onPlugins(
      selected
        ? pluginIds.filter((id) => id !== plugin.id)
        : [...pluginIds, plugin.id],
    );
  };

  return (
    <>
      <Modal title="插件" onClose={onClose} wide>
        <section className="harness-plugins">
          {local && (
            <p className="harness-error">
              当前使用本地电脑，切换到云端后可选择这里的插件。
            </p>
          )}
          {!available && !loading && !local && (
            <p className="harness-error">云端服务暂不可用，请联系管理员。</p>
          )}
          {(error || actionError) && (
            <div className="harness-error" role="alert">
              {actionError || error}
            </div>
          )}
          <div className="harness-toolbar">
            <div className="harness-tabs" role="tablist" aria-label="插件管理">
              {(
                [
                  { id: "market", label: "插件市场", icon: Globe2 },
                  { id: "installed", label: "已安装", icon: Package },
                  { id: "sources", label: "市场来源", icon: Settings2 },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-controls={`harness-tab-${item.id}`}
                  id={`harness-tab-trigger-${item.id}`}
                  onClick={() => {
                    setTab(item.id);
                    setQuery("");
                    setCategory("");
                    setAdding(false);
                    setSource("");
                  }}
                >
                  <item.icon size={15} />
                  {item.label}
                  {item.id === "installed" && <small>{installed.length}</small>}
                </button>
              ))}
            </div>
            <button
              className="button"
              onClick={() => {
                setAdding((value) => !value);
                setSource("");
                setActionError("");
              }}
              disabled={!!busy}
            >
              {adding ? <X size={14} /> : <Plus size={14} />}
              {tab === "sources" ? "添加市场" : "添加插件"}
            </button>
          </div>
          {adding && (
            <form
              className="harness-add-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!source.trim() || busy) return;
                void run(
                  "add",
                  async () => {
                    if (tab === "sources")
                      await harnessApi.addMarketplace(source, sourceName);
                    else
                      await harnessApi.install(
                        source,
                        marketplace || undefined,
                      );
                    setAdding(false);
                    setSource("");
                    setSourceName("");
                  },
                  tab === "sources"
                    ? "市场来源已添加"
                    : "插件安装完成，可在已安装中启用并加入任务",
                );
              }}
            >
              <h3>{tab === "sources" ? "接入插件市场" : "从来源安装插件"}</h3>
              <p>
                {tab === "sources"
                  ? "添加兼容 npm 协议的注册源，浏览并安装其中的 Harness 插件。"
                  : "输入 npm 包名（可带版本）、Git 仓库或插件包来源，云端将校验并执行真实安装。"}
              </p>
              {tab === "sources" && (
                <label>
                  市场名称
                  <input
                    value={sourceName}
                    onChange={(event) => setSourceName(event.target.value)}
                    placeholder="例如：团队插件市场"
                    maxLength={80}
                  />
                </label>
              )}
              <label>
                {tab === "sources" ? "注册源地址" : "插件来源"}
                <input
                  type={tab === "sources" ? "url" : "text"}
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder={
                    tab === "sources"
                      ? "https://registry.example.com"
                      : "@scope/dsh-plugin-name@version"
                  }
                  required
                  autoFocus
                  spellCheck={false}
                  maxLength={2000}
                />
              </label>
              {tab !== "sources" && (
                <label>
                  安装市场
                  <select
                    value={marketplace}
                    onChange={(event) => setMarketplace(event.target.value)}
                  >
                    <option value="">默认 npm 市场</option>
                    {catalog?.marketplaces.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="submit"
                className="button primary"
                disabled={
                  !!busy || !source.trim() || (tab !== "sources" && !available)
                }
              >
                {busy === "add" ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Plus size={14} />
                )}
                {tab === "sources" ? "添加市场" : "安装插件"}
              </button>
            </form>
          )}
          <div
            role="tabpanel"
            id={`harness-tab-${tab}`}
            aria-labelledby={`harness-tab-trigger-${tab}`}
          >
            {tab === "sources" ? (
              <div className="harness-marketplaces">
                {catalog?.marketplaces.map((item) => (
                  <article key={item.id}>
                    <span className="harness-source-icon">
                      <Globe2 size={20} />
                    </span>
                    <div>
                      <h3>
                        {item.name}
                        {item.builtin && <small>内置</small>}
                      </h3>
                      <code>{item.source}</code>
                    </div>
                    {!item.builtin && (
                      <button
                        className="icon-button"
                        aria-label={`移除市场 ${item.name}`}
                        disabled={!!busy}
                        onClick={() =>
                          void run(
                            `source-${item.id}`,
                            () => harnessApi.removeMarketplace(item.id),
                            "市场来源已移除",
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </article>
                ))}
                {!catalog?.marketplaces.length && !loading && (
                  <div className="harness-empty">
                    <Globe2 size={30} />
                    <strong>接入你的插件市场</strong>
                    <p>添加 npm 注册源后，即可浏览市场中的插件。</p>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="harness-search-row">
                  <label className="harness-search">
                    <Search size={16} />
                    <input
                      type="search"
                      aria-label="搜索插件"
                      placeholder={
                        tab === "market"
                          ? "搜索插件名称、能力或 npm 包名"
                          : "搜索已安装插件"
                      }
                      value={query}
                      maxLength={150}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    {searching && <Loader2 size={15} className="spin" />}
                  </label>
                  <select
                    aria-label={
                      tab === "market" ? "选择插件市场" : "选择插件更新市场"
                    }
                    value={marketplace}
                    onChange={(event) => setMarketplace(event.target.value)}
                  >
                    <option value="">
                      {tab === "market"
                        ? "默认 npm 市场"
                        : "更新来源：默认 npm"}
                    </option>
                    {catalog?.marketplaces.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
                {!!categories.length && (
                  <div className="harness-categories" aria-label="插件分类">
                    <button
                      className={!category ? "active" : ""}
                      onClick={() => setCategory("")}
                    >
                      全部
                    </button>
                    {categories.map((item) => (
                      <button
                        key={item}
                        className={category === item ? "active" : ""}
                        onClick={() => setCategory(item)}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                )}
                {(searchError ||
                  results?.error ||
                  (!query && catalog?.error)) && (
                  <div className="harness-error" role="alert">
                    {searchError || results?.error || catalog?.error}
                  </div>
                )}
                <div className="harness-result-caption">
                  <span>
                    {tab === "market"
                      ? "发现适合你的工作能力"
                      : "管理云端已安装的插件"}
                  </span>
                  <small>{visible.length} 个插件</small>
                </div>
                {loading ? (
                  <div className="harness-empty" role="status">
                    <Loader2 size={28} className="spin" />
                    <p>正在连接插件市场…</p>
                  </div>
                ) : (
                  <div className="harness-plugin-grid" aria-busy={searching}>
                    {visible.map((plugin) => {
                      const selected = pluginIds.includes(plugin.id);
                      const homepage = publicUrl(plugin.homepage);
                      const mutating = busy === plugin.id;
                      return (
                        <article
                          className={`harness-plugin-card ${selected ? "selected" : ""}`}
                          key={plugin.id}
                        >
                          <div className="harness-plugin-heading">
                            <span className="harness-plugin-icon">
                              <Package size={23} />
                            </span>
                            <div>
                              <h3 title={plugin.name}>{plugin.name}</h3>
                              <small>
                                {plugin.author || plugin.category || "扩展插件"}
                              </small>
                            </div>
                            {plugin.installed && (
                              <span
                                className={`harness-plugin-state ${plugin.enabled ? "enabled" : ""}`}
                              >
                                {plugin.enabled ? "已启用" : "未启用"}
                              </span>
                            )}
                          </div>
                          <p>
                            {plugin.description ||
                              "安装后可为云端任务扩展工作能力。"}
                          </p>
                          <div className="harness-plugin-meta">
                            <span title={plugin.id}>{plugin.id}</span>
                            <small>v{plugin.version || "—"}</small>
                          </div>
                          <details className="harness-plugin-details">
                            <summary>
                              版本与来源{homepage && <ExternalLink size={11} />}
                            </summary>
                            <code>{plugin.source}</code>
                            {homepage && (
                              <a
                                href={homepage}
                                target="_blank"
                                rel="noreferrer"
                              >
                                查看项目
                                <ArrowUpRight size={12} />
                              </a>
                            )}
                          </details>
                          <div className="harness-plugin-actions">
                            {!plugin.installed ? (
                              <button
                                className="button"
                                disabled={!!busy || !available}
                                onClick={() =>
                                  void run(
                                    plugin.id,
                                    () =>
                                      harnessApi.install(
                                        plugin.source || plugin.id,
                                        marketplace || undefined,
                                      ),
                                    `「${plugin.name}」安装完成`,
                                  )
                                }
                              >
                                {mutating ? (
                                  <Loader2 size={13} className="spin" />
                                ) : (
                                  <Download size={13} />
                                )}
                                安装
                              </button>
                            ) : (
                              <>
                                <button
                                  className={`harness-enable-button ${plugin.enabled ? "enabled" : ""}`}
                                  disabled={!!busy}
                                  onClick={() =>
                                    void run(
                                      plugin.id,
                                      async () => {
                                        await harnessApi.enable(
                                          plugin.id,
                                          !plugin.enabled,
                                        );
                                        if (plugin.enabled)
                                          onPlugins(
                                            pluginIds.filter(
                                              (id) => id !== plugin.id,
                                            ),
                                          );
                                      },
                                      `「${plugin.name}」已${plugin.enabled ? "停用" : "启用"}`,
                                    )
                                  }
                                >
                                  {mutating ? (
                                    <Loader2 size={13} className="spin" />
                                  ) : (
                                    <Power size={13} />
                                  )}
                                  {plugin.enabled ? "停用" : "启用"}
                                </button>
                                <button
                                  className="icon-button"
                                  aria-label={`配置 ${plugin.name}`}
                                  title={
                                    plugin.has_config
                                      ? "编辑插件配置（已保存）"
                                      : "配置插件"
                                  }
                                  disabled={!!busy}
                                  onClick={() => setConfigPlugin(plugin)}
                                >
                                  <Settings2 size={13} />
                                </button>
                                <button
                                  className="icon-button"
                                  title={`更新 ${plugin.name}`}
                                  aria-label={`更新 ${plugin.name}`}
                                  disabled={!!busy}
                                  onClick={() =>
                                    void run(
                                      plugin.id,
                                      () =>
                                        harnessApi.install(
                                          updateSource(plugin),
                                          marketplace ||
                                            plugin.marketplace ||
                                            undefined,
                                        ),
                                      `「${plugin.name}」已完成更新安装`,
                                    )
                                  }
                                >
                                  <RefreshCw size={13} />
                                </button>
                                <button
                                  className="icon-button"
                                  aria-label={`卸载 ${plugin.name}`}
                                  title="卸载插件"
                                  disabled={!!busy}
                                  onClick={() => setRemoveId(plugin.id)}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </>
                            )}
                            {plugin.installed && (
                              <button
                                className={`harness-task-select ${selected ? "selected" : ""}`}
                                disabled={
                                  local ||
                                  !plugin.enabled ||
                                  !available ||
                                  !!busy ||
                                  (!selected && pluginIds.length >= 20)
                                }
                                aria-pressed={selected}
                                onClick={() => select(plugin)}
                              >
                                {selected ? (
                                  <Check size={13} />
                                ) : (
                                  <Plus size={13} />
                                )}
                                {selected ? "已加入任务" : "加入任务"}
                              </button>
                            )}
                          </div>
                          {removeId === plugin.id && (
                            <div
                              className="harness-remove-confirm"
                              role="alert"
                            >
                              <span>卸载「{plugin.name}」？</span>
                              <button
                                disabled={!!busy}
                                onClick={() =>
                                  void run(
                                    plugin.id,
                                    async () => {
                                      await harnessApi.uninstall(plugin.id);
                                      onPlugins(
                                        pluginIds.filter(
                                          (id) => id !== plugin.id,
                                        ),
                                      );
                                      setRemoveId("");
                                    },
                                    `「${plugin.name}」已卸载`,
                                  )
                                }
                              >
                                卸载
                              </button>
                              <button
                                disabled={!!busy}
                                onClick={() => setRemoveId("")}
                              >
                                取消
                              </button>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
                {!visible.length && !loading && !searching && (
                  <div className="harness-empty">
                    <Package size={32} />
                    <strong>
                      {query || category
                        ? "没有找到匹配的插件"
                        : tab === "installed"
                          ? "还没有安装插件"
                          : "市场暂未返回插件"}
                    </strong>
                    <p>
                      {query || category
                        ? "试试其他关键词或分类，也可以直接输入包名安装。"
                        : "从插件市场发现能力，或点击添加插件安装自己的插件。"}
                    </p>
                    <button className="button" onClick={() => setAdding(true)}>
                      <Plus size={14} />
                      添加插件
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <footer className="harness-plugin-footer">
            <span>
              {local
                ? "切换到云端后可选择插件"
                : `本任务已选 ${pluginIds.length} 个插件`}
            </span>
            <button className="button primary" onClick={onClose}>
              完成
              <Check size={14} />
            </button>
          </footer>
        </section>
      </Modal>
      {configPlugin && (
        <BotPluginConfig
          plugin={configPlugin}
          onClose={() => setConfigPlugin(undefined)}
          onSaved={onRefresh}
          feedback={feedback}
        />
      )}
    </>
  );
}
