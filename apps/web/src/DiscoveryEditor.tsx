import type { FormEvent } from "react";
import type { Member } from "./api";
type Kind = "sessions" | "use-cases" | "assumptions" | "approaches" | "metrics";
type Field = {
  name: string;
  label: string;
  source?: string;
  type?: "date" | "number" | "text";
  options?: string[];
  optional?: boolean;
};
const fields: Record<Kind, Field[]> = {
  sessions: [
    { name: "purpose", label: "Purpose" },
    { name: "sessionDate", label: "Date", type: "date" },
    { name: "summary", label: "Summary" },
  ],
  "use-cases": [
    { name: "title", label: "Title" },
    { name: "actor", source: "actorDescription", label: "Person or role" },
    { name: "problemStatement", label: "Problem statement" },
    { name: "desiredOutcome", label: "Desired outcome" },
  ],
  assumptions: [
    { name: "statement", label: "Assumption" },
    {
      name: "status",
      label: "Status",
      options: ["open", "validated", "invalidated"],
    },
    { name: "rationale", label: "Rationale", optional: true },
  ],
  approaches: [
    { name: "title", label: "Title" },
    { name: "description", label: "Description" },
    {
      name: "status",
      label: "Status",
      options: ["considered", "selected", "rejected"],
    },
    {
      name: "effortValue",
      label: "Effort value",
      type: "number",
      optional: true,
    },
    { name: "effortUnit", label: "Effort unit", optional: true },
    { name: "rationale", label: "Rationale", optional: true },
  ],
  metrics: [
    { name: "name", label: "Name" },
    { name: "unit", label: "Unit" },
    { name: "description", label: "Description", optional: true },
    { name: "baseline", label: "Baseline", type: "number", optional: true },
    { name: "target", label: "Target", type: "number", optional: true },
  ],
};
const titles: Record<Kind, string> = {
  sessions: "session",
  "use-cases": "use case",
  assumptions: "assumption",
  approaches: "approach",
  metrics: "outcome measure",
};
export function DiscoveryEditor({
  kind,
  row,
  members,
  busy,
  onSave,
}: {
  kind: Kind;
  row: Record<string, unknown>;
  members: Member[];
  busy: boolean;
  onSave: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form),
      payload: Record<string, unknown> = {
        expectedRevision: Number(row.revision),
      };
    for (const field of fields[kind]) {
      const value = String(data.get(field.name) ?? "").trim();
      if (value || !field.optional)
        payload[field.name] = field.type === "number" ? Number(value) : value;
    }
    if (kind === "sessions")
      payload.participantUserIds = data.getAll("participants");
    if (kind === "approaches") {
      const value = data.get("effortValue"),
        unit = String(data.get("effortUnit") ?? "").trim();
      if (value !== "" && value !== null && unit)
        payload.effort = { value: Number(value), unit };
      delete payload.effortValue;
      delete payload.effortUnit;
    }
    if (await onSave(payload)) form.closest("details")?.removeAttribute("open");
  }
  return (
    <details>
      <summary>Edit {titles[kind]}</summary>
      <form key={String(row.revision)} onSubmit={submit}>
        {fields[kind].map((field) => (
          <label key={field.name}>
            {field.label}
            {field.options ? (
              <select
                aria-label={field.label}
                name={field.name}
                defaultValue={String(
                  row[field.source ?? field.name] ?? field.options[0],
                )}
              >
                {field.options.map((value) => (
                  <option key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            ) : field.type ? (
              <input
                aria-label={field.label}
                name={field.name}
                type={field.type}
                step={field.type === "number" ? "any" : undefined}
                defaultValue={String(row[field.source ?? field.name] ?? "")}
                required={!field.optional}
              />
            ) : (
              <textarea
                aria-label={field.label}
                name={field.name}
                defaultValue={String(row[field.source ?? field.name] ?? "")}
                required={!field.optional}
              />
            )}
          </label>
        ))}
        {kind === "sessions" && (
          <fieldset>
            <legend>Participants</legend>
            {members.map((member) => (
              <label key={member.userId}>
                <input
                  type="checkbox"
                  name="participants"
                  value={member.userId}
                  defaultChecked={(row.participantUserIds as string[]).includes(
                    member.userId,
                  )}
                />
                {member.displayName ?? member.email}
              </label>
            ))}
          </fieldset>
        )}
        <p>
          Saving updates this record. A conflicting revision must be refreshed
          before retrying.
        </p>
        <button disabled={busy}>Save changes</button>
      </form>
    </details>
  );
}
