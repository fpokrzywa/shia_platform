import { useEffect, useState } from "react";
import { api } from "./api";
import "./DiscoveryWork.css";
type P = {
  id: string;
  title: string;
  state: string;
  clientName: string;
  openItems: number;
  overdueItems: number;
  awaitingReviewItems: number;
  openRisks: Record<string, number> | null;
  outcomes:
    | {
        id: string;
        name: string;
        unit: string;
        baseline: number | null;
        target: number | null;
        latestValue: number | null;
        observedOn: string | null;
      }[]
    | null;
  readiness: {
    stageName: string;
    decision: string | null;
    effective: boolean;
    stale: boolean;
  }[];
};
export function Portfolio({
  onOpenEngagement,
}: {
  onOpenEngagement: (id: string) => void;
}) {
  const [rows, setRows] = useState<P[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [client, setClient] = useState(""),
    [state, setState] = useState(""),
    [focus, setFocus] = useState(""),
    [sort, setSort] = useState("title");
  async function refresh() {
    setBusy(true);
    try {
      setRows((await api<{ engagements: P[] }>("/api/portfolio")).engagements);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load portfolio.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  const visible = rows
    .filter(
      (row) =>
        (!search ||
          `${row.title} ${row.clientName}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (!client || row.clientName === client) &&
        (!state || row.state === state) &&
        (!focus ||
          (focus === "overdue" && row.overdueItems > 0) ||
          (focus === "review" && row.awaitingReviewItems > 0) ||
          (focus === "risks" &&
            Object.values(row.openRisks ?? {}).some((n) => n > 0)) ||
          (focus === "outcomes" &&
            !row.outcomes?.some((o) => o.latestValue !== null)) ||
          (focus === "readiness" && row.readiness.some((r) => !r.effective))),
    )
    .sort((a, b) =>
      sort === "overdue"
        ? b.overdueItems - a.overdueItems || a.title.localeCompare(b.title)
        : sort === "open"
          ? b.openItems - a.openItems || a.title.localeCompare(b.title)
          : a.title.localeCompare(b.title),
    );
  return (
    <section className="portfolio">
      <header>
        <h2>Portfolio</h2>
        <p>
          Actual work, risks, review decisions, and measured outcomes across
          engagements you can access.
        </p>
        <button onClick={() => void refresh()} disabled={busy}>
          Refresh portfolio
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="portfolio-filters">
        <label>
          Search engagements
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Engagement or client"
          />
        </label>
        <label>
          Client
          <select
            aria-label="Client"
            value={client}
            onChange={(e) => setClient(e.target.value)}
          >
            <option value="">All clients</option>
            {[...new Set(rows.map((r) => r.clientName))].sort().map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Engagement status
          <select
            aria-label="Engagement status"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">All statuses</option>
            {[...new Set(rows.map((r) => r.state))].sort().map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Focus
          <select
            aria-label="Focus"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
          >
            <option value="">All work</option>
            <option value="overdue">Overdue items</option>
            <option value="review">Items awaiting review</option>
            <option value="risks">Open risks</option>
            <option value="outcomes">No measured outcomes</option>
            <option value="readiness">Stages needing current review</option>
          </select>
        </label>
        <label>
          Sort
          <select
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="title">Engagement name</option>
            <option value="overdue">Most overdue items</option>
            <option value="open">Most open items</option>
          </select>
        </label>
        <button
          onClick={() => {
            setSearch("");
            setClient("");
            setState("");
            setFocus("");
            setSort("title");
          }}
        >
          Clear filters
        </button>
      </div>
      <p role="status">
        Showing {visible.length} of {rows.length} engagements
      </p>
      <div>
        {visible.map((x) => (
          <article key={x.id}>
            <header>
              <div>
                <p>
                  {x.clientName} · {x.state.replaceAll("_", " ")}
                </p>
                <h3>{x.title}</h3>
              </div>
              <button onClick={() => onOpenEngagement(x.id)}>
                Open engagement
              </button>
            </header>
            <dl>
              <div>
                <dt>Open items</dt>
                <dd>{x.openItems}</dd>
              </div>
              <div>
                <dt>Overdue</dt>
                <dd>{x.overdueItems}</dd>
              </div>
              <div>
                <dt>Awaiting review</dt>
                <dd>{x.awaitingReviewItems}</dd>
              </div>
            </dl>
            <p>
              Open risks:{" "}
              {x.openRisks
                ? Object.entries(x.openRisks)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(", ")
                : "0"}
            </p>
            <h4>Outcome measures</h4>
            {x.outcomes?.length ? (
              x.outcomes.map((o) => (
                <p key={o.id}>
                  <strong>{o.name}:</strong> {o.latestValue ?? "No observation"}
                  {o.latestValue != null ? ` ${o.unit}` : ""}{" "}
                  <small>
                    Baseline {o.baseline ?? "—"}; target {o.target ?? "—"}
                  </small>
                </p>
              ))
            ) : (
              <p>No outcome measures recorded.</p>
            )}
            <p>
              {x.readiness.filter((r) => r.effective).length} of{" "}
              {x.readiness.length} stages have a current review decision.
            </p>
          </article>
        ))}
      </div>
      {!busy && !visible.length && (
        <p>
          {rows.length
            ? "No engagements match these filters."
            : "No engagements are available to your account."}
        </p>
      )}
    </section>
  );
}
