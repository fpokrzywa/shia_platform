import type { FinalReadout } from "./readouts.js";
type Row = Record<string, unknown>;
export function formatReadout(report: FinalReadout): string {
  const s = report.snapshot;
  const rows = (key: string) =>
    Array.isArray(s[key]) ? (s[key] as Row[]) : [];
  const safe = (v: unknown) =>
    String(v ?? "Not recorded")
      .replace(
        /[&<>]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!,
      )
      .replace(/[\\`*_{}\[\]#|]/g, "\\$&")
      .replace(/\r?\n/g, " / ");
  const plain = (v: unknown) =>
    safe(String(v ?? "Not recorded").replaceAll("_", " "));
  const people = new Map(
    rows("participants").map((p) => [p.user_id, p.display_name]),
  );
  const person = (v: unknown) =>
    v ? safe(people.get(v) ?? "Recorded participant") : "Unassigned";
  const itemNames = new Map(rows("checklist").map((i) => [i.id, i.name]));
  const e = s.engagement as Row;
  const lines = [
    `# ${safe(report.title)}`,
    "",
    `Report: ${plain(report.state)} | Snapshot: ${safe(report.asOf)}`,
    `Source: ${report.stale ? "Changed since snapshot — generate a new readout for current work" : "Current at the last check"}`,
    "",
    `## Engagement`,
    `Client: ${safe(e.client_name)}`,
    `Engagement: ${safe(e.title)}`,
    `Template: ${safe(e.template_version_name)} — version ${safe(e.template_version)}`,
  ];
  const section = (name: string, entries: string[]) => {
    lines.push(
      "",
      `## ${name}`,
      "",
      ...(entries.length ? entries : ["Nothing recorded."]),
    );
  };
  section(
    "Team",
    rows("participants").map(
      (x) =>
        `- ${safe(x.display_name)}: ${Array.isArray(x.roles) ? x.roles.map(plain).join(", ") : "No roles recorded"}`,
    ),
  );
  section(
    "Scope history",
    rows("scopes").flatMap((x) => [
      `### Version ${safe(x.version)} — ${plain(x.state)}`,
      `Estimate: ${safe(x.estimate)}`,
      ...(["commitments", "exclusions", "acceptance_criteria"] as const).map(
        (k) =>
          `${plain(k)}: ${Array.isArray(x[k]) ? (x[k] as unknown[]).map(safe).join("; ") : "None"}`,
      ),
      `Review rationale: ${safe(x.decision_rationale)}`,
      "",
    ]),
  );
  section(
    "Discovery sessions",
    rows("discoverySessions").map((x) => {
      const participants = Array.isArray(x.participant_user_ids)
        ? x.participant_user_ids.map(person).join(", ")
        : "Not recorded";
      return `- ${safe(x.session_date)} — ${safe(x.purpose)}. Participants: ${participants}. ${safe(x.summary)}`;
    }),
  );
  section(
    "Use cases",
    rows("useCases").map(
      (x) =>
        `- ${safe(x.title)}: ${safe(x.problem_statement)} Actor: ${safe(x.actor_description)} Desired outcome: ${safe(x.desired_outcome)}`,
    ),
  );
  section("Assumptions and approaches", [
    ...rows("assumptions").map(
      (x) =>
        `- Assumption — ${plain(x.status)}: ${safe(x.statement)}. ${safe(x.rationale)}`,
    ),
    ...rows("approaches").map(
      (x) =>
        `- Approach — ${plain(x.status)}: ${safe(x.title)}. ${safe(x.description)} Effort: ${safe(x.effort_value)} ${safe(x.effort_unit)}. ${safe(x.rationale)}`,
    ),
  ]);
  section(
    "Checklist",
    rows("checklist").map(
      (x) =>
        `- ${safe(x.stage_name)} / ${safe(x.name)}: ${plain(x.status)}; owner ${person(x.owner_user_id)}; due ${safe(x.due_date)}`,
    ),
  );
  const stages = (s.readiness as { stages?: Row[] } | undefined)?.stages ?? [];
  section(
    "Readiness review history",
    stages.flatMap((x) => {
      const history = (x.history as Row[] | undefined) ?? [];
      return [
        `### ${safe(x.name)}`,
        ...(history.length
          ? history.flatMap((d) => [
              `- ${plain(d.decision)} — ${d.effective ? "current effective decision" : "historical or no longer effective"}; ${safe(d.actorName)}; ${safe(d.createdAt)}. ${safe(d.rationale)}`,
              ...((d.exceptions as Row[] | undefined) ?? []).map(
                (ex) =>
                  `  - Exception: ${safe(itemNames.get(ex.itemId) ?? "Checklist item")}; ${safe(ex.ownerName)}; due ${safe(ex.dueDate)}. ${safe(ex.rationale)}`,
              ),
            ])
          : ["No review recorded."]),
      ];
    }),
  );
  section(
    "Milestones",
    rows("milestones").map(
      (x) =>
        `- ${safe(x.title)}: ${plain(x.status)}; owner ${person(x.owner_user_id)}; due ${safe(x.due_date)}`,
    ),
  );
  section(
    "Risks",
    rows("risks").map(
      (x) =>
        `- ${safe(x.title)}: ${plain(x.severity)} / ${plain(x.status)}; owner ${person(x.owner_user_id)}. Mitigation: ${safe(x.mitigation)}`,
    ),
  );
  section(
    "Decisions",
    rows("decisions").map(
      (x) =>
        `- ${safe(x.title)}: ${safe(x.decision)}. Rationale: ${safe(x.rationale)} — ${person(x.actor_id)}, ${safe(x.created_at)}`,
    ),
  );
  section(
    "Deliverables",
    rows("deliverables").map(
      (x) => `- ${safe(x.title)}: ${plain(x.status)}. ${safe(x.description)}`,
    ),
  );
  const deliverables = new Map(
    rows("deliverables").map((x) => [x.id, x.title]),
  );
  section(
    "Acceptance records",
    rows("acceptance").map(
      (x) =>
        `- ${safe(x.deliverable_id ? deliverables.get(x.deliverable_id) : "Whole engagement")}: ${plain(x.result)}; ${plain(x.source_type)} review${x.external_name ? ` attributed to ${safe(x.external_name)}` : ""}. ${safe(x.rationale)} — recorded by ${person(x.actor_id)}`,
    ),
  );
  section(
    "Evidence register",
    rows("evidence").map(
      (x) =>
        `- ${safe(x.title)} — ${safe(itemNames.get(x.item_id) ?? "Engagement")}; ${safe(x.url ?? x.file_name)}; recorded by ${person(x.recorded_by)} on ${safe(x.created_at)}. ${x.has_attachment ? "Attachment retained in the access-controlled application." : ""}`,
    ),
  );
  section(
    "Running notes",
    rows("notes").map(
      (x) =>
        `- ${safe(x.created_at)} — ${person(x.actor_id)} (${safe(x.item_id ? itemNames.get(x.item_id) : "Engagement note")}): ${safe(x.body)}`,
    ),
  );
  section(
    "Follow-ups",
    rows("followups").map(
      (x) =>
        `- ${safe(x.title)}: ${plain(x.status)}; owner ${person(x.owner_user_id)}; due ${safe(x.due_date)}`,
    ),
  );
  const observations = rows("outcomeObservations");
  section(
    "Measured outcomes",
    rows("outcomeMetrics").flatMap((metric) => [
      `### ${safe(metric.name)} (${safe(metric.unit)})`,
      `Baseline: ${safe(metric.baseline)} | Target: ${safe(metric.target)}. ${safe(metric.description)}`,
      ...observations
        .filter((entry) => entry.metric_id === metric.id)
        .map(
          (entry) =>
            `- ${safe(entry.observed_on)}: ${safe(entry.value)}. ${safe(entry.note)}${entry.evidence_title ? ` Evidence: ${safe(entry.evidence_title)}.` : ""}`,
        ),
    ]),
  );
  section("Engagement training references", [
    ...rows("trainingReferences").map(
      (x) =>
        `- ${safe(x.name)} — version ${safe(x.version)} (${plain(x.state)}). ${safe(x.purpose)}`,
    ),
    ...(typeof s.trainingPrivacy === "string" ? [safe(s.trainingPrivacy)] : []),
  ]);
  section(
    "Knowledge references",
    rows("knowledgeReferences").map(
      (x) =>
        `- ${safe(x.title)} — ${plain(x.kind)}, version ${safe(x.version)} (${plain(x.state)}). ${safe(x.rationale)}`,
    ),
  );
  section(
    "Open actions",
    rows("openActions").map(
      (x) => `- ${safe(x.title)} (${plain(x.type)}): ${plain(x.status)}`,
    ),
  );
  section(
    "Open obligations",
    rows("openActions").map(
      (x) => `- ${safe(x.title)} (${plain(x.type)}): ${plain(x.status)}`,
    ),
  );
  section("Readout review", [
    report.reviewRationale
      ? `${plain(report.state)}: ${safe(report.reviewRationale)} — ${person(report.reviewedBy)}, ${safe(report.reviewedAt)}`
      : "This readout has not been reviewed.",
  ]);
  return lines.join("\n");
}
