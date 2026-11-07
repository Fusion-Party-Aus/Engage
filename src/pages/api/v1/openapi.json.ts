import type { APIRoute } from "astro";

export const prerender = false;
export const GET: APIRoute = async () =>
  Response.json(
    {
      openapi: "3.1.0",
      info: {
        title: "Engage Policy API",
        version: "1.0.0",
        description:
          "Read-only public catalogue of explicitly published and recognised Engage policy data. Successful GET responses include an ETag and a Link header with the canonical URL; immutable revision responses use long-lived immutable caching.",
      },
      servers: [{ url: "/api/v1" }],
      paths: {
        "/policies": {
          get: {
            summary: "List published policies",
            parameters: [
              { in: "query", name: "branch", schema: { type: "string" } },
              { in: "query", name: "jurisdiction", schema: { type: "string" } },
              {
                in: "query",
                name: "limit",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  default: 50,
                },
              },
              { in: "query", name: "cursor", schema: { type: "string" } },
              {
                in: "header",
                name: "If-None-Match",
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "Page of published policies",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PolicyPage" },
                  },
                },
              },
              "304": { description: "Cached representation is current" },
            },
          },
        },
        "/policies/{id}": {
          get: {
            summary: "Get a published policy",
            parameters: [{ $ref: "#/components/parameters/PolicyId" }],
            responses: {
              "200": {
                description: "Policy",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PolicyResponse" },
                  },
                },
              },
              "404": { description: "Not found or not published" },
            },
          },
        },
        "/policies/{id}/versions": {
          get: {
            summary: "List published policy revisions",
            parameters: [
              { $ref: "#/components/parameters/PolicyId" },
              {
                in: "query",
                name: "limit",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  default: 50,
                },
              },
              { in: "query", name: "cursor", schema: { type: "string" } },
              {
                in: "header",
                name: "If-None-Match",
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "Page of immutable revision history",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/VersionPage" },
                  },
                },
              },
              "304": { description: "Cached representation is current" },
              "404": { description: "Policy not found or not published" },
            },
          },
        },
        "/policies/{id}/versions/{version}": {
          get: {
            summary: "Get an immutable policy revision",
            parameters: [
              { $ref: "#/components/parameters/PolicyId" },
              {
                in: "path",
                name: "version",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "Immutable revision snapshot",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/VersionResponse" },
                  },
                },
              },
              "404": { description: "Not found" },
            },
          },
        },
        "/branches": {
          get: {
            summary: "List recognised branches",
            parameters: [
              {
                in: "query",
                name: "limit",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  default: 50,
                },
              },
              { in: "query", name: "cursor", schema: { type: "string" } },
              {
                in: "header",
                name: "If-None-Match",
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "Page of recognised branches",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/BranchPage" },
                  },
                },
              },
              "304": { description: "Cached representation is current" },
            },
          },
        },
        "/branches/{id}/policies": {
          get: {
            summary: "List published policies for a jurisdiction branch",
            parameters: [
              {
                in: "path",
                name: "id",
                required: true,
                schema: { type: "string" },
              },
              {
                in: "query",
                name: "limit",
                schema: { type: "integer", minimum: 1, maximum: 100 },
              },
              { in: "query", name: "cursor", schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "Published policies",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PolicyPage" },
                  },
                },
              },
            },
          },
        },
        "/policy-categories": {
          get: {
            summary: "List categories represented in published policies",
            responses: {
              "200": {
                description: "Published policy categories",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        data: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        parameters: {
          PolicyId: {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
        },
        schemas: {
          Policy: {
            type: "object",
            required: [
              "policyId",
              "title",
              "summary",
              "approvedWording",
              "revisionId",
              "status",
              "publicationStatus",
            ],
            properties: {
              policyId: { type: "string" },
              title: { type: "string" },
              summary: { type: "string" },
              category: { type: ["string", "null"] },
              commitments: { type: "array", items: { type: "string" } },
              approvedWording: {
                type: "string",
                description: "Exact wording of the ratified revision.",
              },
              revisionId: { type: "string" },
              revisionIds: { type: "array", items: { type: "string" } },
              status: { type: "string", enum: ["adopted"] },
              publicationStatus: {
                type: "string",
                enum: ["published", "withdrawn", "superseded"],
              },
              provenance: {},
              jurisdiction: { type: ["string", "null"] },
              jurisdictionBranchId: { type: ["string", "null"] },
              governanceAuthorityBranchId: { type: ["string", "null"] },
              effectiveAt: { type: ["string", "null"], format: "date-time" },
              publishedAt: { type: ["string", "null"], format: "date-time" },
              ratification: {
                type: ["object", "null"],
                properties: {
                  authorityBranchId: { type: "string" },
                  decisionEventId: { type: "string" },
                  ballotRevisionId: { type: "string" },
                  ratifiedRevisionId: { type: "string" },
                  adoptedAmendmentIds: {
                    type: "array",
                    items: { type: "string" },
                  },
                  ratifiedAt: { type: "string", format: "date-time" },
                },
              },
              supersededBy: { type: ["string", "null"] },
              supersededAt: { type: ["string", "null"], format: "date-time" },
              withdrawnAt: { type: ["string", "null"], format: "date-time" },
            },
          },
          PolicyResponse: {
            type: "object",
            properties: { data: { $ref: "#/components/schemas/Policy" } },
          },
          PolicyPage: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { $ref: "#/components/schemas/Policy" },
              },
              meta: {
                type: "object",
                properties: {
                  limit: { type: "integer" },
                  nextCursor: { type: ["string", "null"] },
                },
              },
            },
          },
          Version: {
            type: "object",
            required: ["revisionId", "contentHash", "createdAt", "snapshot"],
            properties: {
              revisionId: { type: "string" },
              parentRevisionId: { type: ["string", "null"] },
              contentHash: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
              revisionType: { type: "string" },
              adoptedAmendmentIds: { type: "array", items: { type: "string" } },
              snapshot: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  summary: { type: "string" },
                  outcomes: { type: "array", items: { type: "string" } },
                  details: { type: "string" },
                },
              },
              changes: { type: "object" },
            },
          },
          VersionPage: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { $ref: "#/components/schemas/Version" },
              },
              meta: {
                type: "object",
                properties: {
                  limit: { type: "integer" },
                  nextCursor: { type: ["string", "null"] },
                },
              },
            },
          },
          VersionResponse: {
            type: "object",
            properties: { data: { $ref: "#/components/schemas/Version" } },
          },
          Branch: {
            type: "object",
            required: ["branchId", "name", "kind"],
            properties: {
              branchId: { type: "string" },
              name: { type: "string" },
              kind: { type: "string" },
              parentBranchId: { type: ["string", "null"] },
              recognised: { type: "boolean" },
            },
          },
          BranchPage: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { $ref: "#/components/schemas/Branch" },
              },
              meta: {
                type: "object",
                properties: {
                  limit: { type: "integer" },
                  nextCursor: { type: ["string", "null"] },
                },
              },
            },
          },
        },
      },
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
