import { useEffect, useState } from "react";
import { api } from "./api";

type SampleStatus = {
  state: "empty" | "loaded";
  revision: number;
  clients: number;
  engagements: number;
};
export function SampleData() {
  const [status, setStatus] = useState<SampleStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [requestKeys] = useState(() => new Map<string, string>());
  const refresh = async () => {
    setStatus((await api<{ sample: SampleStatus }>("/api/samples")).sample);
    setConfirmed(false);
    setNotice('');
  };
  useEffect(() => {
    refresh().catch((e) =>
      setError(
        e instanceof Error ? e.message : "Could not read sample data status.",
      ),
    );
  }, []);
  async function run(action: "load" | "remove") {
    if (!status || !confirmed) return;
    setBusy(true);
    setError("");
    setNotice("");
    const intent = `${action}:${status.revision}`;
    let requestKey = requestKeys.get(intent);
    if (!requestKey) {
      requestKey = crypto.randomUUID();
      requestKeys.set(intent, requestKey);
    }
    try {
      await api(`/api/samples/${action}`, {
        expectedRevision: status.revision,
        requestKey,
        confirmation: `${action}-sample-data`,
      });
      await refresh();
      setConfirmed(false);
      setNotice(
        action === "load"
          ? "Sample engagements are ready. Open Engagements to explore them."
          : "Sample clients and engagement work have been removed. You can load a fresh copy whenever you want.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The sample data action failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Sample data</h1>
          <p>
            A repeatable walkthrough using fictional clients and engagements.
          </p>
        </div>
        <span className="badge">Administrator tools</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button
            onClick={() => {
              void refresh()
                .then(() => setError(""))
                .catch((e) => setError(e.message));
            }}
          >
            Refresh status
          </button>
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <section>
        <h2>Engagement walkthrough</h2>
        <p>
          Two sample clients and two engagements let you compare apprenticeship
          with independent delivery. Every sample name is marked, and your
          account is the engagement lead. No additional login accounts are
          created.
        </p>
        <div className="form-grid">
          <div>
            <h3>Apprenticeship</h3>
            <p>
              Explore preparation, the first camp, the intervening readiness
              review, the second camp, handover and learning synthesis.
            </p>
          </div>
          <div>
            <h3>Independent delivery</h3>
            <p>
              Explore discovery, scope, build, acceptance, handover and
              learning. This path does not require a Palantir participant.
            </p>
          </div>
        </div>
        <div className="notice">
          This pack supports engagement plans, pinned stages, team roles, checklist work, notes, evidence, readiness reviews, delivery tracking, and readouts.
        </div>
        {!status ? (
          <p>Checking sample data…</p>
        ) : status.state === "loaded" ? (
          <>
            <p>
              <strong>Loaded:</strong> {status.clients} sample clients and{" "}
              {status.engagements} sample engagements.
            </p>
            <h3>Remove the sample work</h3>
            <p>
              Only records tracked as belonging to this sample pack are removed,
              including any changes made inside those sample engagements. Real
              records and accounts are preserved. If a real engagement uses a
              sample client, removal stops so you can resolve that connection
              first.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run("remove");
              }}
            >
              <label className="check">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Remove this pack's sample clients and engagement work, including
                my changes to them.
              </label>
              <button disabled={busy || !confirmed}>
                {busy ? "Removing…" : "Remove sample data"}
              </button>
            </form>
          </>
        ) : (
          <>
            <p>
              <strong>Not loaded.</strong> Loading again after removal creates a
              fresh set of sample work. If earlier sample templates were retired, loading creates a new published sample version and preserves the retired history. Archived sample templates must first be restored from Templates.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run("load");
              }}
            >
              <label className="check">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Load fictional records and sample-only templates for evaluation.
                These templates are not approved delivery policy.
              </label>
              <button className="primary" disabled={busy || !confirmed}>
                {busy ? "Loading…" : "Load sample data"}
              </button>
            </form>
          </>
        )}
        <p className="help">
          Reusable sample template definitions and the load/remove audit history
          remain after removal, so published configuration stays traceable and
          the pack can be reloaded.
        </p>
      </section>
    </>
  );
}
