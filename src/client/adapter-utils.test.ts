/// <reference types="vite/client" />

import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import type { BetterAuthDBSchema } from "better-auth/db";
import { checkUniqueFields, paginate } from "./adapter-utils.js";

const schema = defineSchema({
  account: defineTable({
    issuer: v.string(),
    accountId: v.string(),
  }).index("issuer_accountId", ["issuer", "accountId"]),
});

const betterAuthSchema = {
  account: {
    modelName: "account",
    fields: {
      issuer: { type: "string", required: true },
      accountId: { type: "string", required: true },
    },
    indexes: [{ fields: ["issuer", "accountId"], unique: true }],
  },
} satisfies BetterAuthDBSchema;

const credentialSchema = defineSchema({
  account: defineTable({
    userId: v.string(),
    providerId: v.string(),
    issuer: v.string(),
    accountId: v.string(),
  }).index("userId_providerId_issuer_accountId", [
    "userId",
    "providerId",
    "issuer",
    "accountId",
  ]),
});

const credentialBetterAuthSchema = {
  account: {
    modelName: "account",
    fields: {
      userId: { type: "string", required: true },
      providerId: { type: "string", required: true },
      issuer: { type: "string", required: true },
      accountId: { type: "string", required: true },
    },
  },
} satisfies BetterAuthDBSchema;

const modules = import.meta.glob("../component/**/*.*s");

describe("ordered compound indexes", () => {
  it("uses an index for Better Auth's credential account lookup", async () => {
    const t = convexTest(credentialSchema, modules);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await t.run((ctx) =>
        paginate(ctx, credentialSchema, credentialBetterAuthSchema, {
          model: "account",
          where: [
            { field: "userId", value: "user-1" },
            { field: "providerId", value: "credential" },
            { field: "issuer", value: "local:credential" },
            { field: "accountId", value: "user-1" },
          ],
          paginationOpts: { cursor: null, numItems: 1 },
        })
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("pairs equality values with fields in the selected index order", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("account", {
        issuer: "issuer-value",
        accountId: "account-value",
      });
      await ctx.db.insert("account", {
        issuer: "account-value",
        accountId: "issuer-value",
      });
    });

    const result = await t.run((ctx) =>
      paginate(ctx, schema, betterAuthSchema, {
        model: "account",
        where: [
          { field: "accountId", value: "account-value" },
          { field: "issuer", value: "issuer-value" },
        ],
        paginationOpts: { cursor: null, numItems: 10 },
      })
    );

    expect(result.page).toHaveLength(1);
    expect(result.page[0]).toMatchObject({
      issuer: "issuer-value",
      accountId: "account-value",
    });
  });

  it("checks compound uniqueness against the declared index order", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("account", {
        issuer: "issuer-value",
        accountId: "account-value",
      })
    );

    await expect(
      t.run((ctx) =>
        checkUniqueFields(ctx, schema, betterAuthSchema, "account", {
          issuer: "issuer-value",
          accountId: "account-value",
        })
      )
    ).rejects.toThrow(
      "account unique constraint issuer+accountId already exists"
    );
  });
});

describe("indexed null guards", () => {
  const nullableSchema = defineSchema({
    token: defineTable({
      name: v.string(),
      revokedAt: v.optional(v.union(v.number(), v.null())),
      rank: v.number(),
    }).index("revokedAt_rank", ["revokedAt", "rank"]),
  });
  const nullableAuthSchema = {
    token: {
      modelName: "token",
      fields: {
        name: { type: "string", required: true },
        revokedAt: { type: "number", required: false },
        rank: { type: "number", required: true },
      },
    },
  } satisfies BetterAuthDBSchema;

  it.each(["asc", "desc"] as const)(
    "paginates unset and null values in %s order",
    async (direction) => {
      const t = convexTest(nullableSchema, modules);
      await t.run(async (ctx) => {
        await ctx.db.insert("token", { name: "unset-first", rank: 0 });
        await ctx.db.insert("token", {
          name: "null",
          revokedAt: null,
          rank: 1,
        });
        await ctx.db.insert("token", { name: "unset-last", rank: 2 });
        await ctx.db.insert("token", {
          name: "revoked",
          revokedAt: 1,
          rank: 3,
        });
      });
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      try {
        const names: unknown[] = [];
        let cursor: string | null = null;
        let done = false;
        for (let page = 0; page < 5 && !done; page++) {
          const result = await t.run((ctx) =>
            paginate(ctx, nullableSchema, nullableAuthSchema, {
              model: "token",
              where: [{ field: "revokedAt", value: null }],
              sortBy: { field: "rank", direction },
              paginationOpts: { cursor, numItems: 1 },
            })
          );
          names.push(...result.page.map((doc) => doc.name));
          cursor = result.continueCursor;
          done = result.isDone;
        }
        const expected = ["unset-first", "null", "unset-last"];
        expect(names).toEqual(
          direction === "asc" ? expected : expected.reverse()
        );
        expect(done).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    }
  );

  it("does not use a unique lookup for unset optional values", async () => {
    const t = convexTest(nullableSchema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("token", { name: "unset", rank: 0 });
      await ctx.db.insert("token", { name: "null", revokedAt: null, rank: 1 });
    });
    const authSchema = {
      token: {
        ...nullableAuthSchema.token,
        fields: {
          ...nullableAuthSchema.token.fields,
          revokedAt: { type: "number", required: false, unique: true },
        },
      },
    } satisfies BetterAuthDBSchema;
    const result = await t.run((ctx) =>
      paginate(ctx, nullableSchema, authSchema, {
        model: "token",
        where: [{ field: "revokedAt", operator: "eq", value: null }],
        paginationOpts: { cursor: null, numItems: 10 },
      })
    );
    expect(result.page.map((doc) => doc.name).sort()).toEqual([
      "null",
      "unset",
    ]);
  });
});
