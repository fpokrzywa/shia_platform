import { PracticeExercises } from "./PracticeExercises";
import { DiscoveryWork } from "./DiscoveryWork";
import { Portfolio } from "./Portfolio";
import { TemplateDesigner } from "./TemplateDesigner";
import { Knowledge } from "./Knowledge";
import { Training } from "./Training";
import { FinalReadouts } from "./FinalReadouts";
import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  ApiError,
  type User,
  type Template,
  type Engagement,
  type EngagementDetail,
  type Member,
} from "./api";
import "./style.css";
import { SampleData } from "./SampleData";
import { Ontology, OntologyDiagram } from "./Ontology";
import { EngagementWork } from "./EngagementWork";
import { DeliveryWork } from "./DeliveryWork";
import { ReadinessReview } from "./ReadinessReview";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
const fields = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget).entries());
};
const label = (value: string) =>
  value.replaceAll("_", " ").replaceAll("-", " ");

function App() {
  const [openEngagementId,setOpenEngagementId]=useState<string|undefined>(undefined);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(new URLSearchParams(window.location.search).get("view") === "ontology-diagram" ? "ontology-diagram" : "engagements");
  useEffect(() => {
    const expired = () => {
      if (user) {
        setUser(null);
        setPage("engagements");
        setError("Your session has ended. Sign in again to continue.");
      }
    };
    window.addEventListener("shi:session-expired", expired);
    return () => window.removeEventListener("shi:session-expired", expired);
  }, [user]);
  useEffect(() => {
    api<{ user: User }>("/api/v1/auth/session")
      .then((result) => setUser(result.user))
      .catch((error) => {
        if (!(error instanceof ApiError && error.status === 401))
          setError(message(error));
      })
      .finally(() => setLoading(false));
  }, []);
  if (loading) return <main className="loading">Opening your workspace…</main>;
  if (!user)
    return (
      <Login
        error={error}
        onLogin={(user) => {
          setPage(new URLSearchParams(window.location.search).get("view") === "ontology-diagram" ? "ontology-diagram" : "engagements");
          setError("");
          setUser(user);
        }}
      />
    );
  return (
    <div className="app">
      <aside>
        <a className="brand" href="/">
          SHI <span>Agentic</span>
        </a>
        <p className="sidebar-caption">Engagement workspace</p>
        <nav aria-label="Main navigation">
          {[
            "portfolio",
            "engagements",
            "templates",
            "ontology",
            "practice",
            "training",
            "knowledge",
            ...(user.role === "practice_admin" ? ["team", "samples"] : []),
          ].map((item) => (
            <button
              key={item}
              aria-current={page === item ? "page" : undefined}
              onClick={() => {
                setPage(item);
                setError("");
              }}
            >
              {item === "samples"
                ? "Sample data"
                : item === "practice" ? "Company practice" : item[0]!.toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <div className="account">
          <strong>{user.displayName}</strong>
          <span>{label(user.role)}</span>
          <button
            className="signout"
            onClick={async () => {
              try {
                await api("/api/v1/auth/logout", {});
                setUser(null);
              } catch (error) {
                setError(message(error));
              }
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <span>Practice delivery</span>
          <span className="local">Local development</span>
        </header>
        <main>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {page === "ontology-diagram" ? (
            <OntologyDiagram />
          ) : page === "ontology" ? (
            <Ontology />
          ) : page === "portfolio" ? (
            <Portfolio onOpenEngagement={id=>{setOpenEngagementId(id);setPage("engagements");}} />
          ) : page === "knowledge" ? (
            <Knowledge user={user} />
          ) : page === "practice" ? (
            <PracticeExercises user={user} />
          ) : page === "training" ? (
            <Training user={user} />
          ) : page === "templates" ? (
            <Templates user={user} />
          ) : page === "samples" && user.role === "practice_admin" ? (
            <SampleData />
          ) : page === "team" ? (
            <Team />
          ) : (
            <Engagements user={user} initialSelection={openEngagementId} />
          )}
        </main>
        <footer>
          SHI Agentic · Preparation, delivery and accountable review
        </footer>
      </div>
    </div>
  );
}

function Login({
  error: initialError,
  onLogin,
}: {
  error: string;
  onLogin: (user: User) => void;
}) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    const data = fields(event);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/api/v1/auth/login", data);
      onLogin(result.user);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <section className="login-intro">
        <a className="brand" href="/">
          SHI <span>Agentic</span>
        </a>
        <div>
          <h1>
            From preparation
            <br />
            to confident delivery.
          </h1>
          <p>
            A shared place for engagement plans, responsibilities and evidence.
          </p>
        </div>
        <span>Internal engagement workspace</span>
      </section>
      <main className="login-form">
        <form onSubmit={submit}>
          <h2>Sign in</h2>
          <p>Use your local SHI Agentic account.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <label>
            Email
            <input
              autoComplete="username"
              name="email"
              type="email"
              required
              maxLength={254}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              name="password"
              type="password"
              required
              maxLength={256}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="help">
            First time here? Your local operator must create the initial
            administrator account before you can sign in.
          </p>
        </form>
      </main>
    </div>
  );
}

function Templates({ user }: { user: User }) {
  const [category, setCategory] = useState<"working" | "sample" | "archived">("working");
  const [statusFilter,setStatusFilter] = useState("current");
  const [versionFilter,setVersionFilter] = useState("latest");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<Template | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [requestKeys] = useState(() => new Map<string, string>());
  const refresh = async () => {
    const result = await api<{ templates: Template[] }>("/api/templates");
    setTemplates(result.templates);
    setReady(true);
  };
  useEffect(() => {
    refresh().catch((error) => setError(message(error)));
  }, []);
  async function action(url: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const intent = JSON.stringify([url, body]);
    let requestKey = requestKeys.get(intent);
    if (!requestKey) {
      requestKey = crypto.randomUUID();
      requestKeys.set(intent, requestKey);
    }
    try {
      await api(url, { ...body, requestKey });
      await refresh();
      setSelected(null);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Engagement templates</h1>
          <p>
            Manage your delivery plans here. Working templates and sample copies are kept separate.
          </p>
        </div>
        {user.role === "practice_admin" && (
          <button
            disabled={busy}
            onClick={() => action("/api/templates/import-defaults", {})}
          >
            Load draft definitions
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!selected && <div className="template-categories" role="group" aria-label="Template categories">
        <button aria-pressed={category === "working"} onClick={() => setCategory("working")}>Working templates ({templates.filter(template => !template.isArchived && !template.isSampleTemplate).length})</button>
        <button aria-pressed={category === "sample"} onClick={() => setCategory("sample")}>Sample templates ({templates.filter(template => !template.isArchived && template.isSampleTemplate).length})</button>
        <button aria-pressed={category === "archived"} onClick={() => setCategory("archived")}>Archived ({templates.filter(template => template.isArchived).length})</button>
        <label>Status<select aria-label="Template status" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)} disabled={category==="archived"}><option value="current">Current — draft and published</option><option value="draft">Draft</option><option value="published">Published</option><option value="retired">Retired</option><option value="all">All statuses</option></select></label><label>Version<select aria-label="Template version filter" value={versionFilter} onChange={event=>setVersionFilter(event.target.value)}><option value="latest">Latest matching version</option><option value="all">All versions</option>{Array.from(new Set(templates.map(template=>template.version))).sort((a,b)=>b-a).map(version=><option key={version} value={version}>Version {version}</option>)}</select></label>
        <p>{category === "archived" ? "Archived templates are hidden from active lists. Restore one here to use it again. Nothing is deleted." : category === "sample" ? "These published copies support the sample walkthrough. Removing sample engagements keeps these reusable definitions so the pack can be loaded again." : "Drafts are editable review candidates. Publish a reviewed version before using it for new engagements."}</p>
      </div>}
      {selected ? (
        <section>
          <button className="text-button" onClick={() => setSelected(null)}>
            Back to templates
          </button>
          <div className="detail-title">
            <h2>{selected.definition.name}</h2>
            <span className="badge">
              Version {selected.version} · {selected.state}
            </span>
          </div>
          <p>{selected.definition.purpose}</p>
          {user.role === "practice_admin" && <div className="template-archive">
            <button disabled={busy} onClick={() => action(selected.isArchived ? "/api/templates/restore" : "/api/templates/archive", {templateKey:selected.templateKey,expectedRevision:selected.managementRevision??1})}>{selected.isArchived ? "Restore template" : "Archive template"}</button>
            <p>{selected.isArchived ? "This template is archived. Restore it to make it available again." : "Archive hides all versions of this template. It is only allowed when no engagement uses the template; you can restore it later."}</p>
          </div>}
          <div className="notice">
            {selected.isSampleTemplate ? "This is a reusable sample template. It remains after sample work is removed. Its published definition stays fixed for repeatable sample loading." : "Review ownership and gate rules before publishing. Published versions stay fixed for engagements that use them. Use the management controls below to publish, create a revised version, or retire a version."}
          </div>
          {user.role === "practice_admin" && !selected.isArchived && (selected.state === "published" || selected.state === "draft") && <TemplateDesigner template={selected} onCreated={draft=>{setSelected(draft);void refresh();}} />}
          <h3>Stage sequence</h3>
          <ol className="stages">
            {selected.definition.stages.map((stage) => (
              <li key={stage.key}>
                <div>
                  <h3>{stage.name}</h3>
                  <p>
                    Accountable:{" "}
                    {selected.definition.roles.find(
                      (role) => role.key === stage.accountableRoleKey,
                    )?.name ?? label(stage.accountableRoleKey)}
                    {stage.durationWorkingDays
                      ? ` · Suggested ${stage.durationWorkingDays} working days`
                      : ""}
                  </p>
                  <ul>
                    {stage.checklistItemKeys.map((key) => (
                      <li key={key}>
                        {selected.definition.checklistItems.find(
                          (item) => item.key === key,
                        )?.name ?? key}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
          <h3>Readiness rules</h3>
          <ul className="rules">
            {selected.definition.gateRules.map((rule, i) => (
              <li key={i}>
                <strong>{label(rule.type)}</strong>:{" "}
                {selected.definition.checklistItems.find(
                  (item) => item.key === rule.itemKey,
                )?.name ??
                  selected.definition.stages.find(
                    (stage) => stage.key === rule.stageKey,
                  )?.name}
              </li>
            ))}
          </ul>
          {user.role === "practice_admin" && !selected.isArchived && selected.state === "draft" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action("/api/templates/publish", {
                  templateKey: selected.templateKey,
                  version: selected.version,
                  expectedRevision: selected.revision,
                });
              }}
            >
              <label className="check">
                <input type="checkbox" required />I have reviewed these proposed
                defaults, responsibilities and readiness rules.
              </label>
              <button className="primary" disabled={busy}>
                Publish version {selected.version}
              </button>
            </form>
          )}
          {user.role === "practice_admin" && !selected.isArchived && selected.state === "published" && (
            <form
              onSubmit={(event) => {
                const data = fields(event);
                void action("/api/templates/new-version", {
                  templateKey: selected.templateKey,
                  sourceVersion: selected.version,
                  expectedRevision: selected.revision,
                  reason: data.reason,
                  changes: { name: data.name, purpose: data.purpose },
                });
              }}
            >
              <h3>Propose a new version</h3>
              <label>
                Template name
                <input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={selected.definition.name}
                />
              </label>
              <label>
                Purpose
                <input
                  name="purpose"
                  required
                  maxLength={2000}
                  defaultValue={selected.definition.purpose}
                />
              </label>
              <label>
                Reason for revision
                <input name="reason" required maxLength={2000} />
              </label>
              <p className="help">
                Creates a draft with this name and purpose for further review.
                Existing engagements keep this published version.
              </p>
              <button disabled={busy}>Create draft version</button>
            </form>
          )}
          {user.role === "practice_admin" && !selected.isArchived && selected.state === "published" && (
            <details>
              <summary>Retire this version</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void action("/api/templates/retire", {
                    templateKey: selected.templateKey,
                    version: selected.version,
                    expectedRevision: selected.revision,
                  });
                }}
              >
                <p>
                  Stops new engagements from using this version. Existing
                  engagements and their plans stay available.
                </p>
                <label className="check">
                  <input type="checkbox" required />
                  Retire version {selected.version} for new engagements.
                </label>
                <button disabled={busy}>
                  Retire version {selected.version}
                </button>
              </form>
            </details>
          )}
        </section>
      ) : (
        <section>
          {!ready && !error ? (
            <p>Loading templates…</p>
          ) : templates.filter(template => (category === "archived" ? template.isArchived : !template.isArchived && Boolean(template.isSampleTemplate) === (category === "sample")) && (category === "archived" || statusFilter === "all" || (statusFilter === "current" ? template.state !== "retired" : template.state === statusFilter)) && (versionFilter === "all" || (versionFilter === "latest" ? !templates.some(other => other.templateKey === template.templateKey && other.version > template.version && (category === "archived" || statusFilter === "all" || (statusFilter === "current" ? other.state !== "retired" : other.state === statusFilter))) : template.version === Number(versionFilter)))).length === 0 ? (
            <Empty
              title={templates.length ? "No templates match these filters" : "No templates loaded yet"}
              text={
                category === "archived" ? "Archive an unused template from its management page to remove it from the active lists." : category === "sample" ? "Load the sample walkthrough from Sample data to create its reusable templates." : user.role === "practice_admin"
                  ? "Load the two draft definitions to begin the publication review. This creates configuration only."
                  : "A practice administrator can load and publish templates for your engagements."
              }
            />
          ) : (
            <div className="template-list">
              {templates.filter(template => (category === "archived" ? template.isArchived : !template.isArchived && Boolean(template.isSampleTemplate) === (category === "sample")) && (category === "archived" || statusFilter === "all" || (statusFilter === "current" ? template.state !== "retired" : template.state === statusFilter)) && (versionFilter === "all" || (versionFilter === "latest" ? !templates.some(other => other.templateKey === template.templateKey && other.version > template.version && (category === "archived" || statusFilter === "all" || (statusFilter === "current" ? other.state !== "retired" : other.state === statusFilter))) : template.version === Number(versionFilter)))).map((template) => (
                <button
                  disabled={busy}
                  className="template-row"
                  key={`${template.templateKey}:${template.version}`}
                  onClick={() => setSelected(template)}
                >
                  <div>
                    <h2>{template.definition.name}</h2>
                    <p>{template.definition.purpose}</p>
                    <span>
                      {template.definition.stages.length} stages · Version{" "}
                      {template.version}
                    </span>
                    <p className="template-manage">{user.role === "practice_admin" ? "Manage template" : "View template"}</p>
                  </div>
                  <span className="badge">{template.state}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden="true">
        ◇
      </div>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function Engagements({ user,initialSelection }: { user: User; initialSelection?:string|undefined }) {
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [selected, setSelected] = useState<EngagementDetail | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [ready, setReady] = useState(false);
  const refresh = async () => {
    const result = await api<{ engagements: Engagement[] }>("/api/engagements");
    setEngagements(result.engagements);
    setReady(true);
  };
  useEffect(() => {
    refresh().catch((error) => setError(message(error)));
  }, []);
  async function open(id: string) {
    try {
      const result = await api<{ engagement: EngagementDetail }>(
        `/api/engagements/${encodeURIComponent(id)}`,
      );
      setSelected(result.engagement);
      setError("");
    } catch (error) {
      setError(message(error));
    }
  }
  useEffect(()=>{if(initialSelection)void open(initialSelection);},[initialSelection]);
  if (selected)
    return (
      <EngagementView
        engagement={selected}
        user={user}
        refresh={() => open(selected.id)}
        back={() => setSelected(null)}
      />
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Engagements</h1>
          <p>Plan the work, assign the team and prepare for delivery.</p>
        </div>
        {user.role === "practice_admin" && (
          <button className="primary" onClick={() => setCreating(!creating)}>
            {creating ? "Cancel" : "Create engagement"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {creating && (
        <CreateEngagement
          onCreated={async (id) => {
            setCreating(false);
            await refresh();
            await open(id);
          }}
        />
      )}
      <section>
        {!ready && !error ? (
          <p>Loading engagements…</p>
        ) : engagements.length === 0 ? (
          <Empty
            title="Your next engagement starts here"
            text={
              user.role === "practice_admin"
                ? "Publish a reviewed template, then create an engagement and assign its lead. No client or engagement records have been imported."
                : "Engagements appear here when you are assigned to their team."
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Engagement</th>
                  <th>Template</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {engagements.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => open(item.id)}
                      >
                        {item.title}
                      </button>
                    </td>
                    <td>
                      {label(item.templateKey)} · v{item.templateVersion}
                    </td>
                    <td>
                      <span className="badge">{label(item.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function CreateEngagement({
  onCreated,
}: {
  onCreated: (id: string) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    Promise.all([
      api<{ templates: Template[] }>("/api/templates"),
      api<{ clients: { id: string; name: string }[] }>("/api/clients"),
      api<{ users: User[] }>("/api/users"),
    ])
      .then(([t, c, u]) => {
        setTemplates(t.templates.filter((t) => t.state === "published" && !t.isArchived));
        setClients(c.clients);
        setUsers(u.users);
      })
      .catch((error) => setError(message(error)));
  }, []);
  async function createClient(event: FormEvent<HTMLFormElement>) {
    const data = fields(event);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ client: { id: string; name: string } }>(
        "/api/clients",
        { name: data.name, requestKey: clientKey },
      );
      setClients((current) =>
        current.some((c) => c.id === result.client.id)
          ? current
          : [...current, result.client],
      );
      setClientKey(crypto.randomUUID());
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    const data = fields(event);
    const selected = templates[Number(data.template)];
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ engagement: Engagement }>("/api/engagements", {
        clientId: data.clientId,
        title: data.title,
        leadUserId: data.leadUserId,
        templateKey: selected.templateKey,
        templateVersion: selected.version,
        requestKey,
      });
      await onCreated(result.engagement.id);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="creation">
      <h2>Create engagement</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {templates.length === 0 ? (
        <p className="notice">
          Publish a template in Engagement templates before creating an
          engagement.
        </p>
      ) : (
        <form onSubmit={create}>
          <label>
            Engagement title
            <input name="title" required maxLength={200} />
          </label>
          <div className="form-grid">
            <label>
              Client
              <select name="clientId" required defaultValue="">
                <option value="" disabled>
                  Select a client
                </option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Published template
              <select name="template" required>
                {templates.map((t, i) => (
                  <option key={`${t.templateKey}:${t.version}`} value={i}>
                    {t.definition.name} · v{t.version}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Accountable engagement lead
              <select name="leadUserId" required defaultValue="">
                <option value="" disabled>
                  Select a team member
                </option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} ({u.email})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary" disabled={busy}>
            Create engagement
          </button>
        </form>
      )}
      <details>
        <summary>Add a client</summary>
        <form onSubmit={createClient}>
          <label>
            Client name
            <input name="name" required maxLength={200} />
          </label>
          <p className="help">
            Creates a separate client identity. Similar names are never merged
            automatically.
          </p>
          <button disabled={busy}>Add client</button>
        </form>
      </details>
    </section>
  );
}

function EngagementView({
  engagement,
  user,
  refresh,
  back,
}: {
  engagement: EngagementDetail;
  user: User;
  refresh: () => Promise<void>;
  back: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    api<{ members: Member[] }>(`/api/engagements/${engagement.id}/members`)
      .then((r) => setMembers(r.members))
      .catch((e) => setError(message(e)));
    if (user.role === "practice_admin")
      api<{ users: User[] }>("/api/users")
        .then((r) => setUsers(r.users))
        .catch((e) => setError(message(e)));
  }, [engagement.id, engagement.revision, user.role]);
  async function assign(event: FormEvent<HTMLFormElement>) {
    const data = fields(event);
    setBusy(true);
    setError("");
    try {
      await api(`/api/engagements/${engagement.id}/members`, {
        userId: data.userId,
        role: data.role,
        expectedRevision: engagement.revision,
        requestKey,
      });
      setRequestKey(crypto.randomUUID());
      await refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(member: Member) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/engagements/${engagement.id}/members/remove`, {
        userId: member.userId,
        role: member.role,
        expectedRevision: engagement.revision,
        requestKey,
      });
      setRequestKey(crypto.randomUUID());
      await refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="text-button" onClick={back}>
        Back to engagements
      </button>
      <div className="page-heading">
        <div>
          <h1>{engagement.title}</h1>
          <p>
            {label(engagement.templateKey)} · Pinned version{" "}
            {engagement.templateVersion}
          </p>
        </div>
        <span className="badge">{label(engagement.status)}</span>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}{" "}
          <button
            onClick={() => {
              void refresh()
                .then(() => setError(""))
                .catch((error) => setError(message(error)));
            }}
          >
            Refresh
          </button>
        </p>
      )}
      <DiscoveryWork key={`discovery-${engagement.id}`} engagementId={engagement.id} />
      <EngagementWork key={engagement.id} engagementId={engagement.id} />
      <ReadinessReview key={`readiness-${engagement.id}`} engagementId={engagement.id} />
      <DeliveryWork key={`delivery-${engagement.id}`} engagementId={engagement.id} />
      <FinalReadouts key={`readouts-${engagement.id}`} engagementId={engagement.id} />
      <EngagementKnowledge key={`knowledge-${engagement.id}`} engagementId={engagement.id} user={user} />
      <section>
        <h2>Engagement team</h2>
        <ul className="member-list">
          {members.map((m) => (
            <li key={`${m.userId}:${m.role}`}>
              <strong>
                {m.displayName ??
                  users.find((u) => u.id === m.userId)?.displayName ??
                  m.userId}
              </strong>
              <span>{label(m.role)}</span>
              {user.role === "practice_admin" &&
                !(
                  m.userId === engagement.leadUserId &&
                  m.role === "engagement_lead"
                ) && (
                  <button
                    disabled={busy}
                    aria-label={`Remove ${label(m.role)} role from ${m.displayName ?? m.userId}`}
                    onClick={() => {
                      void remove(m);
                    }}
                  >
                    Remove role
                  </button>
                )}
            </li>
          ))}
        </ul>
        {user.role === "practice_admin" && (
          <form onSubmit={assign}>
            <div className="form-grid">
              <label>
                Team member
                <select name="userId" required>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Engagement role
                <select name="role">
                  {[
                    "engagement_lead",
                    "technical_lead",
                    "engineer",
                    "reviewer",
                  ].map((role) => (
                    <option key={role} value={role}>
                      {label(role)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button disabled={busy}>Assign role</button>
          </form>
        )}
      </section>
    </>
  );
}

function Team() {
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const data = fields(event);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api("/api/v1/auth/users", { ...data, role: "member" });
      form.reset();
      setSuccess(
        "Account created. Assign this person to an engagement to give them access.",
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Team accounts</h1>
          <p>
            Create an internal account, then assign engagement responsibilities.
          </p>
        </div>
      </div>
      <section className="narrow">
        <h2>Add a team member</h2>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p className="notice" role="status">
            {success}
          </p>
        )}
        <form onSubmit={create}>
          <label>
            Full name
            <input name="displayName" required maxLength={100} />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="off"
              required
              maxLength={254}
            />
          </label>
          <label>
            Initial password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              required
            />
          </label>
          <p className="help">
            Use at least 12 characters. Share credentials through your approved
            internal channel.
          </p>
          <button className="primary" disabled={busy}>
            Create member account
          </button>
        </form>
      </section>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);



function EngagementKnowledge({engagementId,user}:{engagementId:string;user:User}){
 const [sources,setSources]=useState<{id:string;type:"note";label:string}[]>([]);
 const [error,setError]=useState("");
 async function refresh(){const r=await api<{work:{notes:{id:string;text:string}[]}}>(`/api/engagements/${engagementId}/work`);setSources(r.work.notes.map(n=>({id:n.id,type:"note",label:n.text.slice(0,120)})));setError("");}
 useEffect(()=>{void refresh().catch(e=>setError(message(e)));},[engagementId]);
 return <section><button onClick={()=>void refresh().catch(e=>setError(message(e)))}>Refresh lesson sources</button>{error&&<p role="alert" className="error">{error}</p>}<Knowledge user={user} engagementId={engagementId} sources={sources}/></section>;
}



