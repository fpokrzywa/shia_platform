import type { TrainingDefinition } from "./training.js";
const csv = (headers: string[], rows: (string | number)[][]) =>
  [headers, ...rows]
    .map((row) =>
      row
        .map((value) => '"' + String(value).replaceAll('"', '""') + '"')
        .join(","),
    )
    .join("\n") + "\n";
const constraints = [
  "All companies and records are fictional. Work in an approved Palantir training environment.",
  "The supplied extracts describe the company situation; the learner determines the problem to pursue, proposed approach and deliverables.",
  "Do not contact external parties or execute real purchases or service changes.",
];
const inventory = Array.from({ length: 36 }, (_, i) => [
  `S-${i + 1}`,
  `P-${100 + (i % 6)}`,
  `L-${1 + (i % 3)}`,
  i % 11 === 0 ? "" : (i * 7) % 43,
  `2026-08-${String(10 + (i % 20)).padStart(2, "0")}`,
  i % 4 === 0 ? "manual count" : "warehouse export",
]);
inventory.push(
  [...inventory[4]!],
  ["S-38", "P-999", "L-2", 12, "2026-08-29", "warehouse export"],
);
const orders = Array.from({ length: 48 }, (_, i) => [
  `O-${i + 1}`,
  `P-${100 + (i % 6)}`,
  `L-${1 + (i % 3)}`,
  1 + (i % 14),
  `2026-08-${String(1 + (i % 25)).padStart(2, "0")}`,
  i % 7 === 0 ? "" : `2026-08-${String(3 + (i % 25)).padStart(2, "0")}`,
  i % 5 === 0 ? "pending" : "shipped",
]);
const requests = Array.from({ length: 45 }, (_, i) => [
  `R-${i + 1}`,
  i === 22 ? "A-99" : `A-${1 + (i % 5)}`,
  [
    "Access request",
    "Intermittent outage",
    "Slow response",
    "Equipment issue",
    "Account change",
  ][i % 5]!,
  ["open", "in progress", "closed", "Open"][i % 4]!,
  `2026-08-${String(1 + (i % 27)).padStart(2, "0")}`,
  i % 4 === 2 ? `2026-08-${String(2 + (i % 27)).padStart(2, "0")}` : "",
  i % 9 === 0 ? "" : `T-${1 + (i % 2)}`,
  ["low", "medium", "high"][i % 3]!,
]);
requests.push([...requests[6]!]);
export const practiceCases: TrainingDefinition[] = [
  {
    key: "palantir-inventory-practice",
    version: 1,
    state: "draft",
    name: "Company challenge: Harbor Distribution",
    purpose:
      "Investigate a fictional distribution business and identify an opportunity worth addressing in Palantir.",
    items: [],
    practiceCase: {
      businessProblem:
        "Harbor Distribution operates three depots. Sales staff report missed customer commitments while warehouse managers say some stock stays on shelves for too long. Purchasing and operations disagree about which information they can trust. Leadership wants to understand where to focus its attention. These extracts are what the company has made available for your initial investigation.",
      audience:
        "New FTE gaining experience investigating business challenges in Palantir.",
      constraints,
      references: [],
      datasets: [
        {
          key: "products",
          fileName: "products.csv",
          description:
            "Product master. product_id: company product identifier; product_name: catalogue label; supplier_id: recorded supplier identifier.",
          csv: csv(
            ["product_id", "product_name", "supplier_id"],
            Array.from({ length: 6 }, (_, i) => [
              `P-${100 + i}`,
              [
                "Control unit",
                "Sensor kit",
                "Cable assembly",
                "Mounting bracket",
                "Power module",
                "Interface board",
              ][i]!,
              `SUP-${1 + (i % 3)}`,
            ]),
          ),
        },
        {
          key: "suppliers",
          fileName: "suppliers.csv",
          description:
            "Supplier directory. supplier_id: supplier identifier; supplier_name: display name; quoted_lead_days: quoted calendar days from order to receipt.",
          csv: csv(
            ["supplier_id", "supplier_name", "quoted_lead_days"],
            [
              ["SUP-1", "Meadow Components", 4],
              ["SUP-2", "Northline Supply", 9],
              ["SUP-3", "Harbor Parts", 6],
            ],
          ),
        },
        {
          key: "locations",
          fileName: "locations.csv",
          description:
            "Depot directory. location_id: depot identifier; location_name: business label.",
          csv: csv(
            ["location_id", "location_name"],
            [
              ["L-1", "East depot"],
              ["L-2", "West depot"],
              ["L-3", "Central depot"],
            ],
          ),
        },
        {
          key: "inventory",
          fileName: "inventory.csv",
          description:
            "Inventory extracts. snapshot_id: source record identifier; product_id and location_id: recorded references; on_hand: reported units; recorded_on: source calendar date; source: originating process.",
          csv: csv(
            [
              "snapshot_id",
              "product_id",
              "location_id",
              "on_hand",
              "recorded_on",
              "source",
            ],
            inventory,
          ),
        },
        {
          key: "orders",
          fileName: "orders.csv",
          description:
            "Customer order lines. order_id: order identifier; product_id and location_id: recorded references; quantity: requested units; requested_on: order date; shipped_on: recorded shipment date when available; status: source status.",
          csv: csv(
            [
              "order_id",
              "product_id",
              "location_id",
              "quantity",
              "requested_on",
              "shipped_on",
              "status",
            ],
            orders,
          ),
        },
      ],
    },
  },
  {
    key: "palantir-service-practice",
    version: 1,
    state: "draft",
    name: "Company challenge: Cedar Services",
    purpose:
      "Investigate a fictional service operation and decide which business problem and outcomes to pursue.",
    items: [],
    practiceCase: {
      businessProblem:
        "Cedar Services supports equipment and internal applications across a growing company. Employees describe recurring disruptions and unpredictable response times. Team leads report that workloads are difficult to explain and ownership sometimes changes during a request. Management has supplied extracts from its service records and asks where an investment in better operational information could help.",
      audience:
        "New FTE investigating an open-ended operational challenge in Palantir.",
      constraints,
      references: [],
      datasets: [
        {
          key: "teams",
          fileName: "teams.csv",
          description:
            "Team directory. team_id: recorded team identifier; team_name: business label.",
          csv: csv(
            ["team_id", "team_name"],
            [
              ["T-1", "Workplace support"],
              ["T-2", "Platform support"],
            ],
          ),
        },
        {
          key: "assets",
          fileName: "assets.csv",
          description:
            "Asset register. asset_id: asset identifier; asset_name: business label; team_id: recorded responsible team.",
          csv: csv(
            ["asset_id", "asset_name", "team_id"],
            [
              ["A-1", "Training laptops", "T-1"],
              ["A-2", "Reporting service", "T-2"],
              ["A-3", "File service", "T-2"],
              ["A-4", "Meeting equipment", "T-1"],
              ["A-5", "Access portal", "T-2"],
            ],
          ),
        },
        {
          key: "requests",
          fileName: "requests.csv",
          description:
            "Service request extract. request_id: source identifier; asset_id: recorded asset; summary: reported issue; status: source workflow label; opened_on and closed_on: recorded calendar dates; team_id: recorded handling team; priority: submitted priority.",
          csv: csv(
            [
              "request_id",
              "asset_id",
              "summary",
              "status",
              "opened_on",
              "closed_on",
              "team_id",
              "priority",
            ],
            requests,
          ),
        },
      ],
    },
  },
];
