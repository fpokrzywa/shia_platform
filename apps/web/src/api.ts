export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (response.status === 204) return {} as T;
  const payload = await response.json();
  if (response.status === 401)
    window.dispatchEvent(new Event("shi:session-expired"));
  if (!response.ok)
    throw new ApiError(
      typeof payload.error === "string"
        ? payload.error
        : (payload.error?.message ?? "The request failed. Please try again."),
      response.status,
    );
  if (payload.data?.actor) return { user: payload.data.actor } as T;
  return payload as T;
}
export type User = {
  id: string;
  email: string;
  displayName: string;
  role: "practice_admin" | "member";
};
export type Template = {
  isSampleTemplate?: boolean;
  isArchived?: boolean;
  managementRevision?: number;
  templateKey: string;
  version: number;
  revision: number;
  state: string;
  definition: {
    name: string;
    purpose: string;
    roles: { key: string; name: string }[];
    stages: {
      key: string;
      name: string;
      accountableRoleKey: string;
      durationWorkingDays?: number;
      checklistItemKeys: string[];
    }[];
    checklistItems: { key: string; name: string; required: boolean }[];
    gateRules: { type: string; itemKey?: string; stageKey?: string }[];
  };
};
export type Engagement = {
  id: string;
  title: string;
  clientId: string;
  templateKey: string;
  templateVersion: number;
  revision: number;
  leadUserId: string;
  status: string;
};
export type EngagementDetail = Engagement & {
  stages: { id: string; name: string; state: string; definitionKey: string }[];
  items: { id: string; name: string; status: string; definitionKey: string }[];
};
export type Member = {
  userId: string;
  role: string;
  displayName?: string;
  email?: string;
};
