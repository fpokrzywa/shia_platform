import { useState } from "react";
type ObjectOverview = {
  name: string;
  purpose: string;
  current: string;
  relationships: string;
  access?: string;
  planned?: string;
};
const objects: ObjectOverview[] = [
  {
    name: "Client",
    purpose: "The organization the work belongs to.",
    current: "Identity, name, creator and created date.",
    relationships: "One client can have many engagements.",
  },
  {
    name: "Template",
    purpose: "A reusable delivery plan and its lifecycle.",
    current:
      "Stable key, name, purpose, archive state, management revision and creator.",
    relationships:
      "Contains numbered versions. Published active versions can start engagements.",
  },
  {
    name: "Template version",
    purpose: "A fixed plan an engagement starts from.",
    current:
      "Version, draft/published/retired state, definition, revision, source version, reason and publication details. Definitions contain roles, stages, checklist items, evidence requirements and gate rules.",
    relationships: "Belongs to a template. Engagements pin one exact version.",
  },
  {
    name: "Engagement",
    purpose: "The working record for one client delivery.",
    current:
      "Title, client, pinned template version, accountable lead, lifecycle state, revision and creation details.",
    relationships:
      "Contains delivery, discovery, work, outcomes and readouts; people join through assignments.",
  },
  {
    name: "Stage and checklist item",
    purpose:
      "Ordered phases and actionable requirements copied from the pinned template.",
    current:
      "Definition keys and snapshots, order, state/status, revision, owner, due date and completion attribution.",
    relationships:
      "Stages and items belong to one engagement. Items link to notes, evidence and readiness reviews.",
  },
  {
    name: "Person and engagement assignment",
    purpose: "An internal account and its separate delivery responsibilities.",
    current:
      "Person identity, email, display name, platform role and disabled date. Assignment roles are engagement lead, technical lead, engineer and reviewer; one person may hold several.",
    relationships:
      "People own work, learn, mentor, review and create audited actions.",
  },
  {
    name: "Evidence and attachment",
    purpose: "Supporting material for a checklist requirement or decision.",
    current:
      "Item, title, classified requirement key, safe HTTP(S) link or private file, filename, supplied media type, byte size, recorder and date. Files are limited to 2 MiB.",
    relationships:
      "Supports checklist work, scope decisions and outcome observations.",
    access:
      "Attachment bytes remain private and require current engagement access. Media types are not trusted for inline display.",
  },
  {
    name: "Engagement note",
    purpose: "A running record of observations and discussion.",
    current:
      "Engagement, optional checklist item, author, bounded text and timestamp.",
    relationships:
      "Can inform readouts and be explicitly submitted as sanitized knowledge.",
    access:
      "The original note stays inside its engagement. Knowledge readers see only separately submitted reusable text.",
  },
  {
    name: "Readiness review",
    purpose:
      "An accountable record of a stage gate decision or reviewed not-applicable item.",
    current:
      "Go, conditional go, no-go and reopen decisions; rationale, reviewer, immutable snapshot/token, exceptions, owners and due dates. Effectiveness becomes stale when source work changes.",
    relationships:
      "Reviews a stage against items, evidence, dependencies and the pinned template.",
  },
  {
    name: "Delivery plan and record",
    purpose: "Tracks agreed delivery from scope through follow-up.",
    current:
      "Immutable proposed/accepted scope versions; milestones; risks and mitigations; immutable decisions; deliverables; immutable acceptance records; follow-ups, owners, dates, status and revisions.",
    relationships:
      "Belongs to an engagement. Accepted scope can be referenced by discovery without copying it.",
  },
  {
    name: "Discovery session",
    purpose:
      "Records structured discovery without flattening it into free text.",
    current:
      "Purpose, session date, participant member IDs, summary, revision and attribution.",
    relationships:
      "Belongs to an engagement and provides context for use cases, assumptions and approaches.",
  },
  {
    name: "Use case, assumption and approach",
    purpose: "Makes the problem, hypotheses and considered options explicit.",
    current:
      "Use-case actor, problem and desired outcome; assumption state and rationale; approach status, rationale and optional effort value/unit.",
    relationships:
      "Belongs to an engagement and may reference its accepted scope baseline.",
  },
  {
    name: "Outcome metric and observation",
    purpose:
      "Records measured results without declaring success automatically.",
    current:
      "Metric name, unit, description, baseline and target. Immutable observations contain dated numeric values, optional note and source evidence.",
    relationships:
      "Belongs to an engagement and contributes factual results to portfolio and readouts.",
  },
  {
    name: "Final readout",
    purpose: "An immutable as-of snapshot for review and safe export.",
    current:
      "Title, source hash, generated snapshot, creator and timestamp; immutable lead/reviewer/admin review history with rationale. Markdown and JSON exports omit attachment bytes.",
    relationships:
      "Summarizes pinned template, participants, work, notes, readiness, delivery, outcomes and open actions. Later source changes mark it stale.",
  },
  {
    name: "Training set and version",
    purpose: "Reusable human-engineering learning paths.",
    current:
      "Draft/published versioned definitions with ordered reading and practical items, purpose, source version, revision reason and publication attribution.",
    relationships:
      "Published versions are pinned to learner assignments and persist independently of engagements.",
  },
  {
    name: "Training assignment and progress",
    purpose:
      "Connects one learner and optional mentor to a pinned learning path.",
    current:
      "Learner, optional mentor and engagement, revisions, per-item progress, learning logs, assignment-owned link/file evidence and immutable mentor assessments with freshness tokens.",
    relationships:
      "Practical completion needs evidence. Competence assessment is separate and becomes stale after progress changes.",
  },
  {
    name: "Knowledge set and version",
    purpose: "A reusable recipe, discovery guide or architecture pattern.",
    current:
      "Draft/submitted/published/retired versions, definition, safe source references, author, reviewer rationale, archive state and private provenance identifiers.",
    relationships:
      "Explicitly submitted lessons may become reviewed knowledge; engagement links pin an exact published version.",
    access:
      "General readers see submitted reusable text and safe references, never the private originating note or learning-log text.",
  },
  {
    name: "Practice review reference",
    purpose: "Protected expected approaches and rubrics used by reviewers.",
    current:
      "Pinned training version, reference version, expected approach, checks, pitfalls, alternatives, rubric, publication rationale and revision.",
    relationships:
      "Reviewers compare learner proposals against a published reference.",
    access:
      "Protected reviewer material is not learner content and must not be exposed to learner-facing reads.",
  },
  {
    name: "Practice proposal",
    purpose: "A learner-authored, immutable version of a proposed solution.",
    current:
      "Selected problem, rationale, questions, proposed approach, deliverables, success criteria, author and date.",
    relationships:
      "Belongs to a training assignment and can be evaluated in a practice comparison.",
    access: "Visible through the assignment's authorized learning workflow.",
  },
  {
    name: "Practice comparison",
    purpose: "An immutable human review of a learner proposal.",
    current:
      "Pinned proposal and protected reference, criterion results, overall feedback, reviewer and date.",
    relationships: "Connects a proposal to the exact review reference used.",
    access:
      "Learners may receive resulting feedback; protected reference content remains reviewer-only.",
  },
  {
    name: "Audit and maintenance history",
    purpose: "Traceability for identity, workspace and operational actions.",
    current:
      "Identity events, engagement-scoped workspace events and operational session-cleanup events with actor/details/timestamps as applicable.",
    relationships:
      "Records supported changes and administrator access. It is distinct from engagement notes.",
  },
  {
    name: "Client solution model",
    purpose: "The client's business objects and relationships being designed.",
    current: "No separate persisted object yet.",
    planned:
      "Versioned solution-model artifacts with engagement review context.",
    relationships:
      "Will link to an engagement while remaining separate from SHI delivery records.",
  },
];
const index = Object.fromEntries(objects.map((o, i) => [o.name, i]));
const links: [string, string, string][] = [
  ["Client", "Engagement", "has"],
  ["Template", "Template version", "versions"],
  ["Template version", "Engagement", "supplies plan for"],
  ["Engagement", "Stage and checklist item", "contains"],
  ["Person and engagement assignment", "Engagement", "assigns people to"],
  ["Stage and checklist item", "Evidence and attachment", "supported by"],
  ["Engagement", "Engagement note", "records"],
  ["Stage and checklist item", "Readiness review", "reviewed by"],
  ["Engagement", "Delivery plan and record", "plans and records"],
  ["Engagement", "Discovery session", "discovers through"],
  ["Discovery session", "Use case, assumption and approach", "produces"],
  ["Engagement", "Outcome metric and observation", "measures"],
  ["Engagement", "Final readout", "summarized by"],
  [
    "Training set and version",
    "Training assignment and progress",
    "assigned as",
  ],
  [
    "Person and engagement assignment",
    "Training assignment and progress",
    "learns or mentors",
  ],
  ["Engagement note", "Knowledge set and version", "explicitly contributes to"],
  [
    "Training assignment and progress",
    "Knowledge set and version",
    "explicitly contributes to",
  ],
  ["Knowledge set and version", "Engagement", "pinned for reuse"],
  ["Training set and version", "Practice review reference", "reviewed against"],
  ["Training assignment and progress", "Practice proposal", "contains"],
  ["Practice proposal", "Practice comparison", "reviewed in"],
  ["Practice review reference", "Practice comparison", "guides"],
  ["Engagement", "Audit and maintenance history", "audited by"],
];
const Details = ({ object }: { object: ObjectOverview }) => (
  <>
    <p>{object.purpose}</p>
    <dl>
      <dt>Stored today</dt>
      <dd>{object.current}</dd>
      {object.access && (
        <>
          <dt>Access boundary</dt>
          <dd>{object.access}</dd>
        </>
      )}
      {object.planned && (
        <>
          <dt>Planned addition</dt>
          <dd>{object.planned}</dd>
        </>
      )}
      <dt>Relationships</dt>
      <dd>{object.relationships}</dd>
    </dl>
  </>
);
export function Ontology() {
  return (
    <div className="ontology">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Application reference</p>
          <h1>Ontology overview</h1>
          <p>
            The stored objects, boundaries and relationships that organize SHI
            Agentic.
          </p>
        </div>
      </div>
      <section aria-label="Relationship overview">
        <a
          href="/?view=ontology-diagram"
          target="_blank"
          rel="noopener noreferrer"
          className="diagram-link"
        >
          Open diagram ↗ <span>(new tab)</span>
        </a>
        <h2>How the pieces connect</h2>
        <p>
          <strong>
            Client → Engagement → pinned template → delivery records
          </strong>
        </p>
        <p>
          Discovery defines the problem and measured outcomes. Work, evidence
          and accountable reviews support delivery. Readouts preserve an as-of
          result. Training and reviewed knowledge carry learning into later
          work.
        </p>
        <p>
          Private engagement sources and reviewer references keep their original
          access boundary even when sanitized lessons or feedback are reused.
        </p>
        <p>This is a maintained design reference, not live client data.</p>
      </section>
      <section aria-label="Object properties">
        <h2>Objects and properties</h2>
        <p>
          Open an object to inspect what is stored and who may see protected
          content.
        </p>
        {objects.map((object) => (
          <details key={object.name} className="ontology-object">
            <summary>
              {object.name}{" "}
              <span className="ontology-status">
                {object.planned ? "Partial foundation" : "Stored today"}
              </span>
            </summary>
            <Details object={object} />
          </details>
        ))}
      </section>
    </div>
  );
}
const cols = 4,
  w = 310,
  h = 145,
  positions = objects.map(
    (_, i) => [25 + (i % cols) * w, 25 + Math.floor(i / cols) * h] as const,
  );
export function OntologyDiagram() {
  const [selected, setSelected] = useState(index.Engagement!),
    [showAll, setShowAll] = useState(false),
    object = objects[selected]!,
    connections = links.map(([a, b, v]) => [index[a]!, index[b]!, v] as const),
    height = Math.ceil(objects.length / cols) * h + 40;
  const select = (i: number) => {
    setSelected(i);
    setShowAll(false);
  };
  return (
    <div className="ontology">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Application reference</p>
          <h1>Ontology diagram</h1>
          <p>
            Select an object to highlight its relationships, properties and
            access boundary.
          </p>
        </div>
      </div>
      <p>
        The diagram describes application structure. It does not scan or expose
        live engagement data. Scroll horizontally to inspect the full map on a
        narrow screen.
      </p>
      <div
        className="ontology-canvas"
        tabIndex={0}
        aria-label="Scrollable ontology relationship diagram"
      >
        <svg
          viewBox={`0 0 ${cols * w + 20} ${height}`}
          width={cols * w + 20}
          height={height}
          role="group"
          aria-label="Object relationships"
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10z" fill="#8693a1" />
            </marker>
          </defs>
          {connections.map(([from, to, verb]) => {
            const [x, y] = positions[from]!,
              [tx, ty] = positions[to]!,
              active = from === selected || to === selected;
            return (
              <g key={`${from}-${to}`} opacity={active ? 1 : 0.12}>
                <path
                  d={`M${x + 130} ${y + 78} L${tx + 130} ${ty}`}
                  fill="none"
                  stroke="#8693a1"
                  strokeWidth="1.5"
                  markerEnd="url(#arrow)"
                />
                {active && (
                  <text
                    x={(x + tx) / 2 + 130}
                    y={(y + ty) / 2 + 39}
                    textAnchor="middle"
                    fontSize="12"
                    fill="#243746"
                    stroke="#f3f5f7"
                    strokeWidth="5"
                    paintOrder="stroke"
                  >
                    {verb}
                  </text>
                )}
              </g>
            );
          })}
          {objects.map((item, i) => {
            const [x, y] = positions[i]!;
            return (
              <g
                key={item.name}
                transform={`translate(${x},${y})`}
                role="button"
                tabIndex={0}
                aria-label={`Inspect ${item.name}`}
                aria-pressed={i === selected}
                onClick={() => select(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select(i);
                  }
                }}
                className="ontology-node"
              >
                <rect
                  width="260"
                  height="78"
                  rx="8"
                  fill={i === selected ? "#f1e7ef" : "white"}
                  stroke={i === selected ? "#752b62" : "#596475"}
                  strokeWidth="2"
                  strokeDasharray={item.planned ? "6 4" : undefined}
                />
                <text x="12" y="29" fontSize="14" fill="#21303d">
                  {item.name.length > 31
                    ? item.name.slice(0, 30) + "…"
                    : item.name}
                </text>
                <text x="12" y="55" fontSize="12" fill="#596475">
                  {item.planned
                    ? "Planned"
                    : item.access
                    ? "Protected access boundary"
                    : "Stored relationship"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <section aria-live="polite">
        <h2>{object.name}</h2>
        <Details object={object} />
      </section>
      <section aria-label="Relationship list">
        <h2>
          {showAll ? "All relationships" : `Relationships for ${object.name}`}
        </h2>
        <button onClick={() => setShowAll(!showAll)}>
          {showAll
            ? "Show selected object relationships"
            : "Show all relationships"}
        </button>
        <ul>
          {connections
            .filter(
              ([from, to]) => showAll || from === selected || to === selected,
            )
            .map(([from, to, verb]) => (
              <li key={`${from}-${to}`}>
                {objects[from]!.name} → {verb} → {objects[to]!.name}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
