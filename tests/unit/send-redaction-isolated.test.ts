import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  graph: vi.fn(),
  mediaUpload: vi.fn(),
  save: vi.fn(),
  events: [] as Array<unknown>,
  graphPayloads: [] as Array<unknown>,
  assets: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  templateBody: "Hola {{1}}: {{2}} y {{3}}",
  graphError: null as Error | null,
}));

const schema = {
  conversation: { organizationId: "organizationId", id: "id", contactId: "contactId" },
  contact: { id: "id", organizationId: "organizationId" },
  template: { organizationId: "organizationId", id: "id" },
  mediaAsset: { id: "id" },
  message: {},
};

const db = {
  select: vi.fn(() => {
    let table: unknown;
    const chain = {
      from(t: unknown) { table = t; return chain; },
      innerJoin() { return chain; },
      where() { return chain; },
      limit: async () => {
        if (table === schema.template) return [{
          id: "template-test", body: h.templateBody, status: "approved",
          name: "test_quote", language: "es_MX",
        }];
        if (table === schema.conversation) return [{
          conversation: { id: "conversation-test", channel: "whatsapp", isTest: false, lastInboundAt: new Date() },
          contact: { phone: "5215550000000", waUserId: null },
        }];
        return [];
      },
    };
    return chain;
  }),
  insert: vi.fn((table: unknown) => ({
    values(value: Record<string, unknown>) {
      const row = { ...value };
      if (table === schema.mediaAsset) h.assets.push(row);
      if (table === schema.message) h.messages.push(row);
      return {
        returning: async () => [row],
      };
    },
  })),
  update: vi.fn(() => ({
    set() { return { where: async () => [] }; },
  })),
};

vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/db/tenant", () => ({ scoped: () => true }));
vi.mock("@/lib/db/ids", () => ({ newId: (kind: string) => kind + "-test" }));
vi.mock("@/server/events/bus", () => ({
  publish: (_org: string, event: unknown) => { h.events.push(event); },
}));
vi.mock("@/server/inbox/ingest", () => ({
  serializeMessage: (message: unknown, media?: unknown) => ({ message, media }),
}));
vi.mock("@/server/inbox/window", () => ({ isWindowOpen: () => true }));
vi.mock("@/server/channels/capabilities", () => ({
  capabilitiesFor: () => ({ outboundMedia: true, outsideWindow: "template", deliveryReceipts: true }),
  textFits: () => true,
  windowClosedMessage: () => "Ventana cerrada",
}));
vi.mock("@/lib/meta/destinatario", () => ({
  destinatarioMeta: () => ({ to: "5215550000000" }),
}));
vi.mock("@/lib/meta/client", () => {
  class MetaApiError extends Error {
    status: number; code: number; isAuthError: boolean;
    constructor(message: string, status = 400, code = 131026) {
      super(message);
      this.status = status; this.code = code; this.isAuthError = false;
    }
  }
  return {
    MetaApiError,
    normalizeRecipient: (phone: string) => phone,
    graphRequest: (...args: unknown[]) => h.graph(...args),
  };
});
vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg: async () => ({
    organizationId: "org-test", phoneNumberId: "phone-test",
    token: "fake", status: "connected",
  }),
  markReconnectRequired: vi.fn(),
  getCredentialsByWabaId: vi.fn(),
}));
vi.mock("@/server/whatsapp/media", () => ({
  validateOutgoing: () => "document",
  saveMediaFile: (...args: unknown[]) => h.save(...args),
  uploadGraphMedia: (...args: unknown[]) => h.mediaUpload(...args),
}));
vi.mock("@/server/instagram/credentials", () => ({
  getInstagramCredentialsByOrg: vi.fn(),
  markInstagramReconnectRequired: vi.fn(),
}));
vi.mock("@/server/messenger/credentials", () => ({
  getMessengerCredentialsByOrg: vi.fn(),
  markMessengerReconnectRequired: vi.fn(),
}));
vi.mock("@/server/instagram/send", () => ({ sendInstagramText: vi.fn() }));
vi.mock("@/server/messenger/send", () => ({ sendMessengerText: vi.fn() }));
vi.mock("@/server/channels/enabled", () => ({ isChannelEnabled: () => true }));

import { sendMediaMessage, SendError } from "@/server/inbox/send";
import { sendTemplate } from "@/server/whatsapp/templates";

const mediaInput = {
  organizationId: "org-test", conversationId: "conversation-test",
  file: { data: Buffer.from("fake-pdf"), mimeType: "application/pdf", fileName: "cotizacion.pdf" },
  caption: "Cotización https://example.test/p/token-123",
};
const templateInput = {
  organizationId: "org-test", conversationId: "conversation-test", templateId: "template-test",
  variables: ["Ana", "COT-001", "https://example.test/p/token-123"],
};
const mask = "https://example.test/p/••••••";
const graphMessageBodies = () => h.graphPayloads.filter((p) => (p as { type?: string }).type !== undefined);

beforeEach(() => {
  vi.clearAllMocks();
  h.assets.length = 0;
  h.messages.length = 0;
  h.events.length = 0;
  h.graphPayloads.length = 0;
  h.graphError = null;
  h.save.mockResolvedValue("/fake/local.pdf");
  h.mediaUpload.mockResolvedValue("wa-media-test");
  h.graph.mockImplementation(async (_path: string, options: { body?: unknown }) => {
    if (options?.body) h.graphPayloads.push(structuredClone(options.body));
    if (h.graphError) throw h.graphError;
    return { messages: [{ id: "wa-message-test" }] };
  });
});

describe("sendMediaMessage: backward compatibility and redaction (no DB / no network)", () => {
  it("with and without storedCaption sends an identical original Graph payload and stores the expected caption", async () => {
    await sendMediaMessage(mediaInput);
    const original = structuredClone(graphMessageBodies()[0]);
    expect(h.assets[0]?.caption).toBe(mediaInput.caption);
    expect(h.messages[0]?.text).toBeNull();

    h.assets.length = 0; h.messages.length = 0; h.events.length = 0; h.graphPayloads.length = 0;
    await sendMediaMessage({ ...mediaInput, storedCaption: "Cotización " + mask });
    expect(graphMessageBodies()[0]).toEqual(original);
    expect((original as { document: { caption: string } }).document.caption).toBe(mediaInput.caption);
    expect(JSON.stringify(original)).not.toContain("••••••");
    expect(h.assets[0]?.caption).toBe("Cotización " + mask);
    expect(h.messages[0]?.text).toBeNull();
    expect(JSON.stringify(h.events)).not.toContain("token-123");
  });

  it.each([
    ["missing", undefined, "Meta rejected token-123", "Meta rejected token-123"],
    ["empty list", [], "Meta rejected token-123", "Meta rejected token-123"],
    ["empty string", [""], "Meta rejected token-123", "Meta rejected token-123"],
    ["repeated literal", ["token-123"], "token-123 and token-123 and token-123", "•••••• and •••••• and ••••••"],
    ["regex characters", [".?+*[]()"], "wrong .?+*[]() and .?+*[]()", "wrong •••••• and ••••••"],
  ])("%s secrets redaction is applied to stored and thrown errors", async (_name, secrets, raw, expected) => {
    const { MetaApiError } = await import("@/lib/meta/client");
    h.graphError = new MetaApiError(raw, 400, 131026);
    const payload = { ...mediaInput, storedCaption: "Cotización " + mask, ...(secrets === undefined ? {} : { secrets }) };
    await expect(sendMediaMessage(payload)).rejects.toMatchObject({
      code: "meta_error",
      message: expected,
    });
    expect(h.messages[0]?.status).toBe("failed");
    expect(h.messages[0]?.error).toBe(expected);
    expect(JSON.stringify(h.events)).not.toContain("https://example.test/p/token-123");
    expect((graphMessageBodies()[0] as { document: { caption: string } }).document.caption).toBe(mediaInput.caption);
    expect(JSON.stringify(graphMessageBodies())).not.toContain("••••••");
  });
});

describe("sendTemplate: backward compatibility and stored variable boundary", () => {
  it("with and without storedVariables sends identical original Graph values and persists the expected body", async () => {
    await sendTemplate(templateInput);
    const original = structuredClone(graphMessageBodies()[0]);
    expect(h.messages[0]?.text).toBe("Hola Ana: COT-001 y https://example.test/p/token-123");
    h.messages.length = 0; h.events.length = 0; h.graphPayloads.length = 0;
    await sendTemplate({ ...templateInput, storedVariables: ["Ana", "COT-001", mask] });
    expect(graphMessageBodies()[0]).toEqual(original);
    expect(JSON.stringify(original)).toContain("https://example.test/p/token-123");
    expect(JSON.stringify(original)).not.toContain("••••••");
    expect(h.messages[0]?.text).toBe("Hola Ana: COT-001 y " + mask);
    expect(JSON.stringify(h.events)).not.toContain("token-123");
  });

  it("fewer storedVariables than variableCount leaves no original variable in the persisted body", async () => {
    await sendTemplate({ ...templateInput, storedVariables: ["Ana", "COT-001"] });
    expect(h.messages[0]?.text).toBe("Hola Ana: COT-001 y ");
    expect(JSON.stringify(h.messages)).not.toContain("token-123");
    expect(JSON.stringify(graphMessageBodies())).not.toContain("••••••");
  });

  it("empty storedVariables entries remain empty in storage; original values still go to Graph", async () => {
    await sendTemplate({ ...templateInput, storedVariables: ["", "COT-001", ""] });
    expect(h.messages[0]?.text).toBe("Hola : COT-001 y ");
    const payload = JSON.stringify(graphMessageBodies());
    expect(payload).toContain("https://example.test/p/token-123");
    expect(payload).not.toContain("••••••");
  });
});
