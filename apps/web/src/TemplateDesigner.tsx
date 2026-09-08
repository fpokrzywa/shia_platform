import { useState, type FormEvent } from "react";
import { api, type Template } from "./api";
import "./TemplateDesigner.css";

type Role = { key: string; name: string; description?: string | undefined };
type Stage = {
  key: string;
  name: string;
  description?: string | undefined;
  accountableRoleKey: string;
  durationWorkingDays?: number | undefined;
  allowSkip?: boolean | undefined;
  dependsOn: string[];
  checklistItemKeys: string[];
};
type Item = {
  key: string;
  stageKey: string;
  name: string;
  description?: string | undefined;
  ownerRoleKey: string;
  required: boolean;
  dependsOn: string[];
  evidenceRequirementKeys?: string[] | undefined;
};
type Evidence = { key: string; name: string; description?: string | undefined };
type Gate =
  | { type: "hard-prerequisite"; itemKey: string }
  | {
      type: "waivable-prerequisite";
      itemKey: string;
      exceptionOwnerRoleKey: string;
    }
  | { type: "stage-complete"; stageKey: string };
type Definition = {
  name: string;
  purpose: string;
  roles: Role[];
  stages: Stage[];
  checklistItems: Item[];
  evidenceRequirements: Evidence[];
  gateRules: Gate[];
};
const move = <T,>(values: T[], index: number, step: number) => {
  const next = [...values],
    to = index + step;
  if (to < 0 || to >= next.length) return values;
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
};
const copy = (d: Definition): Definition => structuredClone(d);
const uniqueKey = (prefix: string, keys: string[]) => {
  let number = keys.length + 1;
  while (keys.includes(`${prefix}-${number}`)) number += 1;
  return `${prefix}-${number}`;
};
export function TemplateDesigner({
  template,
  onCreated,
}: {
  template: Template;
  onCreated?: (template: Template) => void;
}) {
  const [draft, setDraft] = useState<Definition>(() =>
      copy(template.definition as Definition),
    ),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const update = <K extends keyof Definition>(key: K, value: Definition[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  function blocked(kind: "role" | "stage" | "item" | "evidence", key: string) {
    const refs: string[] = [];
    if (kind === "role") {
      draft.stages
        .filter((x) => x.accountableRoleKey === key)
        .forEach((x) => refs.push(`stage “${x.name}”`));
      draft.checklistItems
        .filter((x) => x.ownerRoleKey === key)
        .forEach((x) => refs.push(`item “${x.name}”`));
      draft.gateRules
        .filter(
          (x) =>
            x.type === "waivable-prerequisite" &&
            x.exceptionOwnerRoleKey === key,
        )
        .forEach(() => refs.push("waiver rule"));
    }
    if (kind === "stage") {
      draft.stages
        .filter((x) => x.dependsOn.includes(key))
        .forEach((x) => refs.push(`stage “${x.name}”`));
      draft.checklistItems
        .filter((x) => x.stageKey === key)
        .forEach((x) => refs.push(`item “${x.name}”`));
      draft.gateRules
        .filter((x) => x.type === "stage-complete" && x.stageKey === key)
        .forEach(() => refs.push("stage review rule"));
    }
    if (kind === "item") {
      draft.checklistItems
        .filter((x) => x.dependsOn.includes(key))
        .forEach((x) => refs.push(`item “${x.name}”`));
      draft.gateRules
        .filter((x) => "itemKey" in x && x.itemKey === key)
        .forEach(() => refs.push("readiness rule"));
    }
    if (kind === "evidence")
      draft.checklistItems
        .filter((x) => x.evidenceRequirementKeys?.includes(key))
        .forEach((x) => refs.push(`item “${x.name}”`));
    return refs;
  }
  function remove(kind: "role" | "stage" | "item" | "evidence", key: string) {
    const refs = blocked(kind, key);
    if (refs.length) {
      setError(`Remove references first: ${refs.join(", ")}.`);
      return;
    }
    setError("");
    if (kind === "role")
      update(
        "roles",
        draft.roles.filter((x) => x.key !== key),
      );
    if (kind === "stage")
      update(
        "stages",
        draft.stages.filter((x) => x.key !== key),
      );
    if (kind === "item")
      setItems(draft.checklistItems.filter((x) => x.key !== key));
    if (kind === "evidence")
      update(
        "evidenceRequirements",
        draft.evidenceRequirements.filter((x) => x.key !== key),
      );
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const definition = {
        name: draft.name,
        purpose: draft.purpose,
        roles: draft.roles,
        stages: draft.stages,
        checklistItems: draft.checklistItems,
        evidenceRequirements: draft.evidenceRequirements,
        gateRules: draft.gateRules,
      };
      const editing = template.state === "draft";
      const result = await api<{ template: Template }>(
        editing ? "/api/templates/draft-update" : "/api/templates/new-version",
        editing
          ? {
              templateKey: template.templateKey,
              version: template.version,
              expectedRevision: template.revision,
              reason,
              definition,
              requestKey: crypto.randomUUID(),
            }
          : {
              templateKey: template.templateKey,
              sourceVersion: template.version,
              expectedRevision: template.revision,
              reason,
              changes: definition,
              requestKey: crypto.randomUUID(),
            },
      );
      setNotice(
        editing
          ? `Draft version ${result.template.version} saved.`
          : `Draft version ${result.template.version} created. Review it before publishing.`,
      );
      onCreated?.(result.template);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The draft could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }
  const patchRole = (i: number, p: Partial<Role>) =>
    update(
      "roles",
      draft.roles.map((x, n) => (n === i ? { ...x, ...p } : x)),
    );
  const patchStage = (i: number, p: Partial<Stage>) =>
    update(
      "stages",
      draft.stages.map((x, n) => (n === i ? { ...x, ...p } : x)),
    );
  const patchItem = (i: number, p: Partial<Item>) =>
    setItems(
      draft.checklistItems.map((x, n) => (n === i ? { ...x, ...p } : x)),
    );
  const patchEvidence = (i: number, p: Partial<Evidence>) =>
    update(
      "evidenceRequirements",
      draft.evidenceRequirements.map((x, n) => (n === i ? { ...x, ...p } : x)),
    );
  function setItems(items: Item[]) {
    setDraft((current) => ({
      ...current,
      checklistItems: items,
      stages: current.stages.map((stage) => ({
        ...stage,
        checklistItemKeys: items
          .filter((item) => item.stageKey === stage.key)
          .map((item) => item.key),
      })),
    }));
  }
  return (
    <details className="template-designer">
      <summary>
        {template.state === "draft"
          ? "Edit this draft"
          : "Design a new version"}
      </summary>
      <form onSubmit={save}>
        <header>
          <h3>Template designer</h3>
          <p>
            {template.state === "draft"
              ? "Correct this draft before publication. Every save is revision checked and audited."
              : "Build a draft with named responsibilities, ordered work and explicit readiness rules. The published version stays unchanged."}
          </p>
        </header>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        <section className="designer-basics">
          <label>
            Template name
            <input
              value={draft.name}
              required
              maxLength={200}
              onChange={(e) => update("name", e.target.value)}
            />
          </label>
          <label>
            Purpose
            <textarea
              value={draft.purpose}
              required
              maxLength={2000}
              onChange={(e) => update("purpose", e.target.value)}
            />
          </label>
        </section>
        <Editor
          title="Roles"
          help="Name the responsibilities used for stage accountability and checklist ownership."
          add={() =>
            update("roles", [
              ...draft.roles,
              {
                key: uniqueKey(
                  "role",
                  draft.roles.map((role) => role.key),
                ),
                name: "New role",
              },
            ])
          }
        >
          {draft.roles.map((role, i) => (
            <Card
              key={role.key}
              title={role.name}
              up={() => update("roles", move(draft.roles, i, -1))}
              down={() => update("roles", move(draft.roles, i, 1))}
              remove={() => remove("role", role.key)}
            >
              <label>
                Stable key
                <input value={role.key} required readOnly />
              </label>
              <label>
                Name
                <input
                  value={role.name}
                  required
                  onChange={(e) => patchRole(i, { name: e.target.value })}
                />
              </label>
              <label className="wide">
                Description
                <textarea
                  value={role.description ?? ""}
                  onChange={(e) =>
                    patchRole(i, { description: e.target.value || undefined })
                  }
                />
              </label>
            </Card>
          ))}
        </Editor>
        <Editor
          title="Stages"
          help="Stages appear in this order. Dependencies describe which stages must come first."
          add={() =>
            update("stages", [
              ...draft.stages,
              {
                key: uniqueKey(
                  "stage",
                  draft.stages.map((stage) => stage.key),
                ),
                name: "New stage",
                accountableRoleKey: draft.roles[0]?.key ?? "",
                dependsOn: [],
                checklistItemKeys: [],
              },
            ])
          }
        >
          {draft.stages.map((stage, i) => (
            <Card
              key={stage.key}
              title={stage.name}
              up={() => update("stages", move(draft.stages, i, -1))}
              down={() => update("stages", move(draft.stages, i, 1))}
              remove={() => remove("stage", stage.key)}
            >
              <label>
                Stable key
                <input value={stage.key} required readOnly />
              </label>
              <label>
                Name
                <input
                  value={stage.name}
                  required
                  onChange={(e) => patchStage(i, { name: e.target.value })}
                />
              </label>
              <label>
                Accountable role
                <select
                  value={stage.accountableRoleKey}
                  onChange={(e) =>
                    patchStage(i, { accountableRoleKey: e.target.value })
                  }
                >
                  {draft.roles.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Working days
                <input
                  type="number"
                  min="1"
                  value={stage.durationWorkingDays ?? ""}
                  onChange={(e) =>
                    patchStage(i, {
                      durationWorkingDays: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </label>
              <label className="wide">
                Description
                <textarea
                  value={stage.description ?? ""}
                  onChange={(e) =>
                    patchStage(i, { description: e.target.value || undefined })
                  }
                />
              </label>
              <Checks
                label="Depends on stages"
                values={draft.stages.filter((x) => x.key !== stage.key)}
                selected={stage.dependsOn}
                change={(dependsOn) => patchStage(i, { dependsOn })}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={stage.allowSkip ?? false}
                  onChange={(e) =>
                    patchStage(i, { allowSkip: e.target.checked })
                  }
                />
                This stage may be skipped after review
              </label>
            </Card>
          ))}
        </Editor>
        <Editor
          title="Checklist"
          help="Each item belongs to one stage and one owner role. Dependencies can cross stages."
          add={() => {
            const stage = draft.stages[0]?.key ?? "";
            setItems([
              ...draft.checklistItems,
              {
                key: uniqueKey(
                  "item",
                  draft.checklistItems.map((item) => item.key),
                ),
                stageKey: stage,
                name: "New checklist item",
                ownerRoleKey: draft.roles[0]?.key ?? "",
                required: true,
                dependsOn: [],
                evidenceRequirementKeys: [],
              },
            ]);
          }}
        >
          {draft.checklistItems.map((item, i) => (
            <Card
              key={item.key}
              title={item.name}
              up={() => setItems(move(draft.checklistItems, i, -1))}
              down={() => setItems(move(draft.checklistItems, i, 1))}
              remove={() => remove("item", item.key)}
            >
              <label>
                Stable key
                <input value={item.key} required readOnly />
              </label>
              <label>
                Name
                <input
                  value={item.name}
                  required
                  onChange={(e) => patchItem(i, { name: e.target.value })}
                />
              </label>
              <label>
                Stage
                <select
                  value={item.stageKey}
                  onChange={(e) => patchItem(i, { stageKey: e.target.value })}
                >
                  {draft.stages.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Owner role
                <select
                  value={item.ownerRoleKey}
                  onChange={(e) =>
                    patchItem(i, { ownerRoleKey: e.target.value })
                  }
                >
                  {draft.roles.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wide">
                Description
                <textarea
                  value={item.description ?? ""}
                  onChange={(e) =>
                    patchItem(i, { description: e.target.value || undefined })
                  }
                />
              </label>
              <Checks
                label="Depends on checklist items"
                values={draft.checklistItems.filter((x) => x.key !== item.key)}
                selected={item.dependsOn}
                change={(dependsOn) => patchItem(i, { dependsOn })}
              />
              <Checks
                label="Required evidence"
                values={draft.evidenceRequirements}
                selected={item.evidenceRequirementKeys ?? []}
                change={(evidenceRequirementKeys) =>
                  patchItem(i, { evidenceRequirementKeys })
                }
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={item.required}
                  onChange={(e) => patchItem(i, { required: e.target.checked })}
                />
                Required for delivery
              </label>
            </Card>
          ))}
        </Editor>
        <Editor
          title="Evidence requirements"
          help="Give evidence a clear name so engineers can classify uploads against it."
          add={() =>
            update("evidenceRequirements", [
              ...draft.evidenceRequirements,
              {
                key: uniqueKey(
                  "evidence",
                  draft.evidenceRequirements.map((evidence) => evidence.key),
                ),
                name: "New evidence requirement",
              },
            ])
          }
        >
          {draft.evidenceRequirements.map((ev, i) => (
            <Card
              key={ev.key}
              title={ev.name}
              up={() =>
                update(
                  "evidenceRequirements",
                  move(draft.evidenceRequirements, i, -1),
                )
              }
              down={() =>
                update(
                  "evidenceRequirements",
                  move(draft.evidenceRequirements, i, 1),
                )
              }
              remove={() => remove("evidence", ev.key)}
            >
              <label>
                Stable key
                <input value={ev.key} required readOnly />
              </label>
              <label>
                Name
                <input
                  value={ev.name}
                  required
                  onChange={(e) => patchEvidence(i, { name: e.target.value })}
                />
              </label>
              <label className="wide">
                Description
                <textarea
                  value={ev.description ?? ""}
                  onChange={(e) =>
                    patchEvidence(i, {
                      description: e.target.value || undefined,
                    })
                  }
                />
              </label>
            </Card>
          ))}
        </Editor>
        <Editor
          title="Readiness rules"
          help="Hard prerequisites cannot be waived. Waivable prerequisites need an exception owner. Stage review rules identify the stage being reviewed."
          add={() =>
            update("gateRules", [
              ...draft.gateRules,
              { type: "stage-complete", stageKey: draft.stages[0]?.key ?? "" },
            ])
          }
        >
          {draft.gateRules.map((gate, i) => (
            <Card
              key={i}
              title={gate.type.replaceAll("-", " ")}
              up={() => update("gateRules", move(draft.gateRules, i, -1))}
              down={() => update("gateRules", move(draft.gateRules, i, 1))}
              remove={() =>
                update(
                  "gateRules",
                  draft.gateRules.filter((_, n) => n !== i),
                )
              }
            >
              <label>
                Rule type
                <select
                  value={gate.type}
                  onChange={(e) => {
                    const type = e.target.value as Gate["type"];
                    const next: Gate =
                      type === "stage-complete"
                        ? { type, stageKey: draft.stages[0]?.key ?? "" }
                        : type === "hard-prerequisite"
                          ? {
                              type,
                              itemKey: draft.checklistItems[0]?.key ?? "",
                            }
                          : {
                              type,
                              itemKey: draft.checklistItems[0]?.key ?? "",
                              exceptionOwnerRoleKey: draft.roles[0]?.key ?? "",
                            };
                    update(
                      "gateRules",
                      draft.gateRules.map((x, n) => (n === i ? next : x)),
                    );
                  }}
                >
                  <option value="hard-prerequisite">Hard prerequisite</option>
                  <option value="waivable-prerequisite">
                    Waivable prerequisite
                  </option>
                  <option value="stage-complete">Stage review</option>
                </select>
              </label>
              {gate.type === "stage-complete" ? (
                <label>
                  Stage
                  <select
                    value={gate.stageKey}
                    onChange={(e) =>
                      update(
                        "gateRules",
                        draft.gateRules.map((x, n) =>
                          n === i ? { ...gate, stageKey: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    {draft.stages.map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label>
                    Checklist item
                    <select
                      value={gate.itemKey}
                      onChange={(e) =>
                        update(
                          "gateRules",
                          draft.gateRules.map((x, n) =>
                            n === i ? { ...gate, itemKey: e.target.value } : x,
                          ),
                        )
                      }
                    >
                      {draft.checklistItems.map((x) => (
                        <option key={x.key} value={x.key}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {gate.type === "waivable-prerequisite" && (
                    <label>
                      Exception owner role
                      <select
                        value={gate.exceptionOwnerRoleKey}
                        onChange={(e) =>
                          update(
                            "gateRules",
                            draft.gateRules.map((x, n) =>
                              n === i
                                ? {
                                    ...gate,
                                    exceptionOwnerRoleKey: e.target.value,
                                  }
                                : x,
                            ),
                          )
                        }
                      >
                        {draft.roles.map((x) => (
                          <option key={x.key} value={x.key}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </Card>
          ))}
        </Editor>
        <footer>
          <label>
            {template.state === "draft"
              ? "Reason for this correction"
              : "Reason for this version"}
            <textarea
              value={reason}
              required
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain what changed and why."
            />
          </label>
          <button className="primary" disabled={busy}>
            {template.state === "draft"
              ? "Save draft changes"
              : "Create draft version"}
          </button>
        </footer>
      </form>
    </details>
  );
}
function Editor({
  title,
  help,
  add,
  children,
}: {
  title: string;
  help: string;
  add: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="designer-section">
      <header>
        <div>
          <h4>{title}</h4>
          <p>{help}</p>
        </div>
        <button type="button" onClick={add}>
          Add {title.toLowerCase().replace(/s$/, "")}
        </button>
      </header>
      {children}
    </section>
  );
}
function Card({
  title,
  up,
  down,
  remove,
  children,
}: {
  title: string;
  up: () => void;
  down: () => void;
  remove: () => void;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="designer-card">
      <legend>{title}</legend>
      <div className="order">
        <button type="button" aria-label={`Move ${title} up`} onClick={up}>
          ↑
        </button>
        <button type="button" aria-label={`Move ${title} down`} onClick={down}>
          ↓
        </button>
        <button type="button" onClick={remove}>
          Remove
        </button>
      </div>
      {children}
    </fieldset>
  );
}
function Checks({
  label,
  values,
  selected,
  change,
}: {
  label: string;
  values: { key: string; name: string }[];
  selected: string[];
  change: (x: string[]) => void;
}) {
  return (
    <fieldset className="designer-checks">
      <legend>{label}</legend>
      {values.length ? (
        values.map((x) => (
          <label className="check" key={x.key}>
            <input
              type="checkbox"
              checked={selected.includes(x.key)}
              onChange={(e) =>
                change(
                  e.target.checked
                    ? [...selected, x.key]
                    : selected.filter((k) => k !== x.key),
                )
              }
            />
            {x.name}
          </label>
        ))
      ) : (
        <span>None available</span>
      )}
    </fieldset>
  );
}
