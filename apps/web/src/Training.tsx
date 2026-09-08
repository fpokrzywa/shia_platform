import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type User } from "./api";
import "./Training.css";
type Item = {
  key: string;
  type: "reading" | "practical";
  title: string;
  description: string;
  url?: string | undefined;
  required?: boolean;
};
type SetRow = {
  is_practice?: boolean;
  training_key: string;
  name: string;
  purpose: string;
  version: number;
  state: "draft" | "published";
  revision: string | number;
};
type VersionDetail = {
  definition: {
    key: string;
    version: number;
    state: "draft" | "published";
    name: string;
    purpose: string;
    items: Item[];
  };
  revision: string | number;
};
type Editor = {
  source: SetRow;
  mode: "draft" | "new-version";
  name: string;
  purpose: string;
  items: (Item & { editorId: string })[];
  reason: string;
};
type AssignmentRow = {
  id: string;
  training_key: string;
  training_version: number;
  learner_user_id: string;
  mentor_user_id: string | null;
  learner_display_name?: string;
  mentor_display_name?: string | null;
  engagement_id: string | null;
  assessment_revision: string | number;
  assigned_at: string;
};
type Progress = {
  item_key: string;
  status: "not_started" | "in_progress" | "complete";
  revision: string | number;
  training_evidence_id: string | null;
  engagement_evidence_id: string | null;
};
type Evidence = {
  id: string;
  item_key: string | null;
  title: string;
  source_date: string | null;
  url: string | null;
  file_name: string | null;
  has_attachment: boolean;
  recorded_by: string;
  created_at: string;
};
type Log = {
  id: string;
  item_key: string | null;
  body: string;
  actor_id: string;
  created_at: string;
};
type Assessment = {
  id: string;
  result: "competent" | "needs_development";
  rationale: string;
  assessor_id: string;
  created_at: string;
  stale: boolean;
};
type AssignmentDetail = {
  assignment: AssignmentRow;
  definition: { name: string; purpose: string; items: Item[] };
  progress: Progress[];
  logs: Log[];
  evidence: Evidence[];
  assessments: Assessment[];
};
const msg = (e: unknown) =>
  e instanceof Error ? e.message : "The request failed.";
const f = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget).entries());
};
const display = (v: string) =>
  v.replaceAll("_", " ").replace(/^./, (x) => x.toUpperCase());
function base64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(Error("The attachment could not be read."));
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.readAsDataURL(file);
  });
}
const blank = (): Item => ({
  key: "",
  type: "reading",
  title: "",
  description: "",
  required: true,
});

export function Training({ user }: { user?: User }) {
  const admin = user?.role === "practice_admin",
    [sets, setSets] = useState<SetRow[]>([]),
    [assignments, setAssignments] = useState<AssignmentRow[]>([]),
    [users, setUsers] = useState<User[]>([]),
    [selected, setSelected] = useState<AssignmentDetail | null>(null),
    [tab, setTab] = useState<"learning" | "catalog">("learning"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [items, setItems] = useState<Item[]>([blank()]),
    [editor, setEditor] = useState<Editor | null>(null);
  const [keys] = useState(() => new Map<string, string>());
  const name = (id: string | null) =>
    users.find((x) => x.id === id)?.displayName ??
    (id === user?.id ? user.displayName : "Participant");
  async function refresh() {
    const calls: [
      Promise<{ sets: SetRow[] }>,
      Promise<{ assignments: AssignmentRow[] }>,
    ] = [api("/api/training/sets"), api("/api/training/assignments")];
    const [s, a] = await Promise.all(calls);
    const courses = s.sets.filter((set) => !set.is_practice);
    setSets(courses);
    setAssignments(
      a.assignments.filter((assignment) =>
        courses.some(
          (set) =>
            set.training_key === assignment.training_key &&
            set.version === assignment.training_version,
        ),
      ),
    );
    if (admin) setUsers((await api<{ users: User[] }>("/api/users")).users);
    if (selected)
      setSelected(
        (
          await api<{ assignment: AssignmentDetail }>(
            `/api/training/assignments/${selected.assignment.id}`,
          )
        ).assignment,
      );
    setError("");
  }
  useEffect(() => {
    void refresh().catch((e) => setError(msg(e)));
  }, [user?.id]);
  async function mutate(
    path: string,
    payload: Record<string, unknown>,
    success: string,
  ) {
    const intent = JSON.stringify([path, payload]);
    let requestKey = keys.get(intent);
    if (!requestKey) {
      requestKey = crypto.randomUUID();
      keys.set(intent, requestKey);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<Record<string, unknown>>(path, {
        ...payload,
        requestKey,
      });
      await refresh();
      keys.delete(intent);
      setNotice(success);
      return result;
    } catch (e) {
      setError(msg(e));
      if (e instanceof ApiError && e.status === 409)
        setNotice("This training record changed. Refresh before trying again.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setBusy(true);
    try {
      setSelected(
        (
          await api<{ assignment: AssignmentDetail }>(
            `/api/training/assignments/${id}`,
          )
        ).assignment,
      );
      setError("");
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }
  function setItem(index: number, patch: Partial<Item>) {
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }
  async function openEditor(row: SetRow) {
    setBusy(true);
    setError("");
    try {
      const detail = (
        await api<{ version: VersionDetail }>(
          `/api/training/sets/${encodeURIComponent(row.training_key)}/${row.version}`,
        )
      ).version;
      setEditor({
        source: { ...row, revision: detail.revision },
        mode: row.state === "draft" ? "draft" : "new-version",
        name: detail.definition.name,
        purpose: detail.definition.purpose,
        items: detail.definition.items.map((item) => ({
          ...item,
          editorId: crypto.randomUUID(),
        })),
        reason: "",
      });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }
  function changeEditorItem(editorId: string, patch: Partial<Item>) {
    setEditor((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) =>
              item.editorId === editorId ? { ...item, ...patch } : item,
            ),
          }
        : current,
    );
  }
  function moveEditorItem(index: number, direction: -1 | 1) {
    setEditor((current) => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.items.length) return current;
      const next = [...current.items];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return { ...current, items: next };
    });
  }
  async function saveEditor(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editor) return;
    const definitionItems = editor.items.map(
      ({ editorId: _, ...item }) => item,
    );
    const path =
      editor.mode === "draft"
        ? `/api/training/sets/${encodeURIComponent(editor.source.training_key)}/${editor.source.version}/draft`
        : `/api/training/sets/${encodeURIComponent(editor.source.training_key)}/${editor.source.version}/versions`;
    const result = await mutate(
      path,
      {
        expectedRevision: Number(editor.source.revision),
        name: editor.name,
        purpose: editor.purpose,
        items: definitionItems,
        ...(editor.mode === "new-version" ? { reason: editor.reason } : {}),
      },
      editor.mode === "draft"
        ? "Training draft updated."
        : "New training draft created.",
    );
    if (result) setEditor(null);
  }
  async function createSet(e: FormEvent<HTMLFormElement>) {
    const form = e.currentTarget,
      d = f(e);
    if (
      await mutate(
        "/api/training/sets",
        { key: d.key, name: d.name, purpose: d.purpose, items },
        "Training draft created.",
      )
    ) {
      form.reset();
      setItems([blank()]);
    }
  }
  async function upload(e: FormEvent<HTMLFormElement>) {
    if (!selected) return;
    const form = e.currentTarget,
      d = f(e),
      file = d.file instanceof File && d.file.size ? d.file : null,
      url = String(d.url ?? "").trim();
    if (Number(Boolean(file)) + Number(Boolean(url)) !== 1) {
      setError("Provide one evidence link or one attachment.");
      return;
    }
    if (file && file.size > 2097152) {
      setError("Attachments must be 2 MiB or smaller.");
      return;
    }
    const payload: Record<string, unknown> = { title: d.title };
    if (d.itemKey) payload.itemKey = d.itemKey;
    if (d.sourceDate) payload.sourceDate = d.sourceDate;
    if (file) {
      payload.fileName = file.name;
      payload.mediaType = file.type || "application/octet-stream";
      try {
        payload.base64 = await base64(file);
      } catch (e) {
        setError(msg(e));
        return;
      }
    } else payload.url = url;
    if (
      await mutate(
        `/api/training/assignments/${selected.assignment.id}/evidence`,
        payload,
        "Evidence added.",
      )
    )
      form.reset();
  }
  const canLearn =
      selected && (admin || selected.assignment.learner_user_id === user?.id),
    canAssess =
      selected && (admin || selected.assignment.mentor_user_id === user?.id);
  return (
    <section className="training">
      <header className="training-header">
        <div>
          <p className="eyebrow">Practice capability</p>
          <h2>Training</h2>
          <p>
            Build practical skills, keep learning evidence, and make mentor
            assessment visible.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => void refresh().catch((e) => setError(msg(e)))}
        >
          Refresh
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <nav aria-label="Training sections" className="training-tabs">
        <button
          className={tab === "learning" ? "selected" : ""}
          onClick={() => setTab("learning")}
        >
          My learning
        </button>
        <button
          className={tab === "catalog" ? "selected" : ""}
          onClick={() => setTab("catalog")}
        >
          Training sets
        </button>
      </nav>
      <div hidden={tab !== "catalog"} className="training-panel">
        <h3>Training sets</h3>
        {sets.length ? (
          <div className="training-set-list">
            {sets.map((row) => (
              <article key={`${row.training_key}-${row.version}`}>
                <div>
                  <h4>{row.name}</h4>
                  <p>
                    Version {row.version} · {display(row.state)}
                  </p>
                </div>
                {admin && (
                  <div className="training-set-actions">
                    <button
                      disabled={busy}
                      onClick={() => void openEditor(row)}
                    >
                      {row.state === "draft"
                        ? "Edit draft"
                        : "Create new version"}
                    </button>
                    {row.state === "draft" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/api/training/sets/${encodeURIComponent(row.training_key)}/${row.version}/publish`,
                            { expectedRevision: Number(row.revision) },
                            `${row.name} published.`,
                          )
                        }
                      >
                        Publish
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p>No training sets yet.</p>
        )}
        {admin && editor && (
          <section className="training-editor" aria-label="Training set editor">
            <header>
              <div>
                <p className="eyebrow">
                  {editor.mode === "draft"
                    ? `Editing draft version ${editor.source.version}`
                    : `New version from version ${editor.source.version}`}
                </p>
                <h4>Training set editor</h4>
                <p>
                  Keep the learning sequence readable and move items into the
                  order learners should follow.
                </p>
              </div>
              <button type="button" onClick={() => setEditor(null)}>
                Close editor
              </button>
            </header>
            <form onSubmit={(e) => void saveEditor(e)}>
              <div className="training-grid">
                <label>
                  Name
                  <input
                    required
                    maxLength={300}
                    value={editor.name}
                    onChange={(e) =>
                      setEditor((current) =>
                        current
                          ? { ...current, name: e.target.value }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="wide">
                  Purpose
                  <textarea
                    required
                    maxLength={5000}
                    value={editor.purpose}
                    onChange={(e) =>
                      setEditor((current) =>
                        current
                          ? { ...current, purpose: e.target.value }
                          : current,
                      )
                    }
                  />
                </label>
              </div>
              <h4>Ordered learning items</h4>
              {editor.items.map((item, index) => (
                <fieldset key={item.editorId}>
                  <legend>Item {index + 1}</legend>
                  <div className="training-order-actions">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => moveEditorItem(index, -1)}
                      aria-label={`Move ${item.title || `item ${index + 1}`} earlier`}
                    >
                      Move earlier
                    </button>
                    <button
                      type="button"
                      disabled={index === editor.items.length - 1}
                      onClick={() => moveEditorItem(index, 1)}
                      aria-label={`Move ${item.title || `item ${index + 1}`} later`}
                    >
                      Move later
                    </button>
                  </div>
                  <label>
                    Item key
                    <input
                      required
                      maxLength={200}
                      value={item.key}
                      onChange={(e) =>
                        changeEditorItem(item.editorId, { key: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Type
                    <select
                      value={item.type}
                      onChange={(e) =>
                        changeEditorItem(item.editorId, {
                          type: e.target.value as Item["type"],
                        })
                      }
                    >
                      <option value="reading">Reading</option>
                      <option value="practical">Practical</option>
                    </select>
                  </label>
                  <label>
                    Title
                    <input
                      required
                      maxLength={300}
                      value={item.title}
                      onChange={(e) =>
                        changeEditorItem(item.editorId, {
                          title: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="wide">
                    Description
                    <textarea
                      required
                      maxLength={10000}
                      value={item.description}
                      onChange={(e) =>
                        changeEditorItem(item.editorId, {
                          description: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Reading link
                    <input
                      type="url"
                      maxLength={2048}
                      value={item.url ?? ""}
                      onChange={(e) =>
                        changeEditorItem(item.editorId, {
                          url: e.target.value || undefined,
                        })
                      }
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={item.required ?? false}
                      onChange={(e) =>
                        changeEditorItem(item.editorId, {
                          required: e.target.checked,
                        })
                      }
                    />{" "}
                    Required
                  </label>
                  {editor.items.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setEditor((current) =>
                          current
                            ? {
                                ...current,
                                items: current.items.filter(
                                  (candidate) =>
                                    candidate.editorId !== item.editorId,
                                ),
                              }
                            : current,
                        )
                      }
                    >
                      Remove item
                    </button>
                  )}
                </fieldset>
              ))}
              <button
                type="button"
                onClick={() =>
                  setEditor((current) =>
                    current
                      ? {
                          ...current,
                          items: [
                            ...current.items,
                            { ...blank(), editorId: crypto.randomUUID() },
                          ],
                        }
                      : current,
                  )
                }
              >
                Add training item
              </button>
              {editor.mode === "new-version" && (
                <label className="training-reason">
                  Reason for new version
                  <textarea
                    required
                    maxLength={5000}
                    value={editor.reason}
                    onChange={(e) =>
                      setEditor((current) =>
                        current
                          ? { ...current, reason: e.target.value }
                          : current,
                      )
                    }
                  />
                </label>
              )}
              <div className="training-editor-actions">
                <button className="primary" disabled={busy}>
                  {editor.mode === "draft"
                    ? "Save draft changes"
                    : "Create draft version"}
                </button>
              </div>
            </form>
          </section>
        )}
        {admin && (
          <details className="training-author">
            <summary>Create training set</summary>
            <form onSubmit={(e) => void createSet(e)}>
              <div className="training-grid">
                <label>
                  Training key
                  <input name="key" required maxLength={200} />
                </label>
                <label>
                  Name
                  <input name="name" required maxLength={300} />
                </label>
                <label className="wide">
                  Purpose
                  <textarea name="purpose" required maxLength={5000} />
                </label>
              </div>
              <h4>Training items</h4>
              {items.map((item, index) => (
                <fieldset key={index}>
                  <legend>Item {index + 1}</legend>
                  <label>
                    Item key
                    <input
                      value={item.key}
                      required
                      maxLength={200}
                      onChange={(e) => setItem(index, { key: e.target.value })}
                    />
                  </label>
                  <label>
                    Type
                    <select
                      value={item.type}
                      onChange={(e) =>
                        setItem(index, { type: e.target.value as Item["type"] })
                      }
                    >
                      <option value="reading">Reading</option>
                      <option value="practical">Practical</option>
                    </select>
                  </label>
                  <label>
                    Title
                    <input
                      value={item.title}
                      required
                      maxLength={300}
                      onChange={(e) =>
                        setItem(index, { title: e.target.value })
                      }
                    />
                  </label>
                  <label className="wide">
                    Description
                    <textarea
                      value={item.description}
                      required
                      maxLength={10000}
                      onChange={(e) =>
                        setItem(index, { description: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Reading link
                    <input
                      type="url"
                      value={item.url ?? ""}
                      onChange={(e) =>
                        setItem(index, { url: e.target.value || undefined })
                      }
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={item.required ?? false}
                      onChange={(e) =>
                        setItem(index, { required: e.target.checked })
                      }
                    />{" "}
                    Required
                  </label>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setItems((x) => x.filter((_, i) => i !== index))
                      }
                    >
                      Remove item {index + 1}
                    </button>
                  )}
                </fieldset>
              ))}
              <button
                type="button"
                onClick={() => setItems((x) => [...x, blank()])}
              >
                Add training item
              </button>{" "}
              <button disabled={busy}>Create training draft</button>
            </form>
          </details>
        )}
      </div>
      <div hidden={tab !== "learning"} className="training-panel">
        <div className="training-column">
          <h3>Assignments</h3>
          {assignments.length ? (
            assignments.map((a) => (
              <button
                className={
                  selected?.assignment.id === a.id
                    ? "assignment selected"
                    : "assignment"
                }
                key={a.id}
                onClick={() => void open(a.id)}
              >
                <strong>
                  {sets.find(
                    (s) =>
                      s.training_key === a.training_key &&
                      s.version === a.training_version,
                  )?.name ?? a.training_key}
                </strong>
                <small>
                  Learner: {a.learner_display_name ?? name(a.learner_user_id)} ·
                  Mentor:{" "}
                  {a.mentor_display_name ??
                    (a.mentor_user_id
                      ? name(a.mentor_user_id)
                      : "Not assigned")}
                </small>
              </button>
            ))
          ) : (
            <p>No training assigned yet.</p>
          )}
          {admin && (
            <details>
              <summary>Assign training</summary>
              <form
                onSubmit={async (e) => {
                  const form = e.currentTarget,
                    d = f(e),
                    [trainingKey, version] = String(d.training).split("::");
                  if (
                    await mutate(
                      "/api/training/assignments",
                      {
                        trainingKey,
                        version: Number(version),
                        learnerUserId: d.learnerUserId,
                        mentorUserId: d.mentorUserId,
                      },
                      "Training assigned.",
                    )
                  )
                    form.reset();
                }}
              >
                <label>
                  Published training
                  <select name="training" required>
                    {sets
                      .filter((s) => s.state === "published")
                      .map((s) => (
                        <option
                          value={`${s.training_key}::${s.version}`}
                          key={`${s.training_key}-${s.version}`}
                        >
                          {s.name} · version {s.version}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Learner
                  <select name="learnerUserId" required>
                    {users.map((x) => (
                      <option value={x.id} key={x.id}>
                        {x.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Mentor
                  <select name="mentorUserId" required>
                    {users.map((x) => (
                      <option value={x.id} key={x.id}>
                        {x.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={busy}>Assign training</button>
              </form>
            </details>
          )}
        </div>
        {selected && (
          <article className="assignment-detail">
            <header>
              <div>
                <p className="eyebrow">
                  Version {selected.assignment.training_version}
                </p>
                <h3>{selected.definition.name}</h3>
                <p>{selected.definition.purpose}</p>
              </div>
              <p>
                Learner{" "}
                <strong>
                  {selected.assignment.learner_display_name ??
                    name(selected.assignment.learner_user_id)}
                </strong>
                <br />
                Mentor{" "}
                <strong>
                  {selected.assignment.mentor_display_name ??
                    (selected.assignment.mentor_user_id
                      ? name(selected.assignment.mentor_user_id)
                      : "Not assigned")}
                </strong>
              </p>
            </header>
            <div className="training-items">
              {selected.definition.items.map((item) => {
                const progress = selected.progress.find(
                  (p) => p.item_key === item.key,
                )!;
                const evidence = selected.evidence.filter(
                  (x) => x.item_key === item.key,
                );
                return (
                  <details key={item.key}>
                    <summary>
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {display(item.type)} · {display(progress.status)}
                        </small>
                      </span>
                    </summary>
                    <p>{item.description}</p>
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noreferrer">
                        Open reading
                      </a>
                    )}
                    {item.type === "practical" && (
                      <p className="help">
                        Practical completion requires linked evidence.
                      </p>
                    )}
                    {canLearn && (
                      <form
                        onSubmit={(e) => {
                          const d = f(e);
                          const payload: Record<string, unknown> = {
                            expectedRevision: Number(progress.revision),
                            status: d.status,
                          };
                          if (d.trainingEvidenceId)
                            payload.trainingEvidenceId = d.trainingEvidenceId;
                          void mutate(
                            `/api/training/assignments/${selected.assignment.id}/progress/${encodeURIComponent(item.key)}`,
                            payload,
                            "Progress updated.",
                          );
                        }}
                      >
                        <label>
                          Progress
                          <select name="status" defaultValue={progress.status}>
                            <option value="not_started">Not started</option>
                            <option value="in_progress">In progress</option>
                            <option value="complete">Complete</option>
                          </select>
                        </label>
                        <label>
                          Evidence
                          <select
                            name="trainingEvidenceId"
                            defaultValue={progress.training_evidence_id ?? ""}
                          >
                            <option value="">No evidence linked</option>
                            {evidence.map((x) => (
                              <option value={x.id} key={x.id}>
                                {x.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button disabled={busy}>Save progress</button>
                      </form>
                    )}
                    <div>
                      {evidence.map((x) => (
                        <p className="evidence" key={x.id}>
                          <strong>{x.title}</strong>
                          {x.url ? (
                            <a href={x.url} target="_blank" rel="noreferrer">
                              Open evidence
                            </a>
                          ) : x.has_attachment ? (
                            <a
                              href={`/api/training/assignments/${selected.assignment.id}/evidence/${x.id}/download`}
                            >
                              Download {x.file_name}
                            </a>
                          ) : null}
                        </p>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
            <div className="learning-support">
              <details>
                <summary>Add evidence</summary>
                <form onSubmit={(e) => void upload(e)}>
                  <label>
                    Training item
                    <select name="itemKey">
                      <option value="">General evidence</option>
                      {selected.definition.items.map((x) => (
                        <option value={x.key} key={x.key}>
                          {x.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Evidence title
                    <input name="title" required maxLength={300} />
                  </label>
                  <label>
                    Source date
                    <input name="sourceDate" type="date" />
                  </label>
                  <label>
                    Link
                    <input name="url" type="url" maxLength={2000} />
                  </label>
                  <label>
                    Or attachment
                    <input name="file" type="file" />
                  </label>
                  <button disabled={busy}>Add evidence</button>
                </form>
              </details>
              {canLearn && (
                <details>
                  <summary>Add learning log</summary>
                  <form
                    onSubmit={async (e) => {
                      const form = e.currentTarget,
                        d = f(e);
                      if (
                        await mutate(
                          `/api/training/assignments/${selected.assignment.id}/logs`,
                          {
                            text: d.text,
                            ...(d.itemKey ? { itemKey: d.itemKey } : {}),
                          },
                          "Learning log added.",
                        )
                      )
                        form.reset();
                    }}
                  >
                    <label>
                      Training item
                      <select name="itemKey">
                        <option value="">Whole assignment</option>
                        {selected.definition.items.map((x) => (
                          <option value={x.key} key={x.key}>
                            {x.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Reflection
                      <textarea name="text" required maxLength={10000} />
                    </label>
                    <button disabled={busy}>Add learning log</button>
                  </form>
                </details>
              )}
            </div>
            {selected.logs.length > 0 && (
              <section>
                <h4>Learning log</h4>
                {selected.logs.map((x) => (
                  <blockquote key={x.id}>
                    {x.body}
                    <footer>
                      {name(x.actor_id)} ·{" "}
                      {new Date(x.created_at).toLocaleString()}
                    </footer>
                  </blockquote>
                ))}
              </section>
            )}
            <section>
              <h4>Mentor assessments</h4>
              {selected.assessments.map((x) => (
                <article
                  className={x.stale ? "assessment stale" : "assessment"}
                  key={x.id}
                >
                  <strong>{display(x.result)}</strong>
                  {x.stale && (
                    <span>Progress changed after this assessment</span>
                  )}
                  <p>{x.rationale}</p>
                </article>
              ))}
              {canAssess && (
                <details>
                  <summary>Assess learner</summary>
                  <form
                    onSubmit={(e) => {
                      const d = f(e);
                      void mutate(
                        `/api/training/assignments/${selected.assignment.id}/assessments`,
                        {
                          expectedRevision: Number(
                            selected.assignment.assessment_revision,
                          ),
                          result: d.result,
                          rationale: d.rationale,
                        },
                        "Assessment recorded.",
                      );
                    }}
                  >
                    <label>
                      Assessment
                      <select name="result">
                        <option value="competent">Competent</option>
                        <option value="needs_development">
                          Needs development
                        </option>
                      </select>
                    </label>
                    <label>
                      Rationale
                      <textarea name="rationale" required maxLength={10000} />
                    </label>
                    <button disabled={busy}>Record assessment</button>
                  </form>
                </details>
              )}
            </section>
          </article>
        )}
      </div>
    </section>
  );
}
