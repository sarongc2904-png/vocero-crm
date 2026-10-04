import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => {
  let states: unknown[] = [];
  let refs: Array<{ current: unknown }> = [];
  let stateIndex = 0;
  let refIndex = 0;
  let runEffects = true;
  let cleanups: Array<() => void> = [];

  return {
    reset() {
      for (const cleanup of cleanups) cleanup();
      states = [];
      refs = [];
      cleanups = [];
      stateIndex = 0;
      refIndex = 0;
      runEffects = true;
    },
    beginRender(effects = true) {
      stateIndex = 0;
      refIndex = 0;
      runEffects = effects;
    },
    state(index: number) {
      return states[index];
    },
    useState<T>(initial: T) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      const setState = (value: T | ((previous: T) => T)) => {
        states[index] =
          typeof value === "function"
            ? (value as (previous: T) => T)(states[index] as T)
            : value;
      };
      return [states[index] as T, setState] as const;
    },
    useRef<T>(initial: T) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index] as { current: T };
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T) {
      return callback;
    },
    useEffect(effect: () => void | (() => void)) {
      if (!runEffects) return;
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
  };
});

vi.mock("react", () => ({
  useState: hooks.useState,
  useRef: hooks.useRef,
  useCallback: hooks.useCallback,
  useEffect: hooks.useEffect,
}));

vi.mock("lucide-react", () => ({
  Loader2: "loader-icon",
  MessageCircle: "message-icon",
}));

vi.mock("@/components/ui/button", () => ({ Button: "button" }));

import { EmbeddedSignupButton } from "@/components/settings/embedded-signup-button";

const ORIGIN = "https://www.facebook.com";
const IDS = { waba_id: "1234567890", phone_number_id: "9876543210" };
const PARTIAL_MESSAGE = "No pudimos completar la conexión. Inténtalo de nuevo.";

type LoginCallback = (response: {
  authResponse?: { code?: string } | null;
}) => void;

let messageListener: ((event: MessageEvent) => void) | null;
let loginCallback: LoginCallback | null;
let fetchMock: ReturnType<typeof vi.fn>;
let onConnected: ReturnType<typeof vi.fn<(displayPhoneNumber: string) => void>>;

function message(event: string, data?: Record<string, unknown>) {
  return { type: "WA_EMBEDDED_SIGNUP", event, ...(data ? { data } : {}) };
}

function text(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) {
    return text((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
  return "";
}

function renderButton(effects = true): ReactElement<{ children: ReactNode }> {
  hooks.beginRender(effects);
  return EmbeddedSignupButton({
    config: {
      appId: "app-id",
      configId: "config-id",
      graphVersion: "v25.0",
      state: "initial-state",
    },
    onConnected,
  }) as ReactElement<{ children: ReactNode }>;
}

function click(tree: ReactElement<{ children: ReactNode }>): void {
  const children = tree.props.children as ReactElement<{ onClick: () => void }>[];
  children[0]!.props.onClick();
}

function emit(origin: string, data: unknown): void {
  messageListener?.({ origin, data } as MessageEvent);
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

async function startAndReceiveCode(): Promise<void> {
  click(renderButton());
  await flush();
  expect(loginCallback).not.toBeNull();
  loginCallback?.({ authResponse: { code: "oauth-code" } });
  await flush();
}

function expectNormalButton(expectedText: string): void {
  expect(hooks.state(0)).not.toBe("loading_sdk");
  expect(hooks.state(0)).not.toBe("waiting_popup");
  expect(hooks.state(0)).not.toBe("finishing");
  expect(text(renderButton(false))).toContain(expectedText);
  expect(text(renderButton(false))).not.toContain("Conectando…");
}

function backendCalls(): unknown[][] {
  return fetchMock.mock.calls.filter(
    ([url]) => url === "/api/settings/whatsapp/embedded-signup"
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  hooks.reset();
  messageListener = null;
  loginCallback = null;
  onConnected = vi.fn();
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/settings/whatsapp") {
      return Response.json({
        embeddedSignup: { available: true, state: "fresh-state" },
      });
    }
    return Response.json({ ok: true, displayPhoneNumber: "+52 55 0000 0000" });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {
    FB: {
      init: vi.fn(),
      login: vi.fn((callback: LoginCallback) => {
        loginCallback = callback;
      }),
    },
    addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") messageListener = listener;
    }),
    removeEventListener: vi.fn(),
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("comportamiento del botón de Embedded Signup", () => {
  it("FINISH exacto con IDs llama al backend y vuelve a estado normal", async () => {
    await startAndReceiveCode();
    emit(ORIGIN, message("FINISH", IDS));
    await flush();

    expect(backendCalls()).toHaveLength(1);
    expect(onConnected).toHaveBeenCalledWith("+52 55 0000 0000");
    expectNormalButton("Conectar WhatsApp");
  });

  it("FINISH_* es partial, no llama al backend y muestra mensaje fijo", async () => {
    await startAndReceiveCode();
    emit(ORIGIN, message("FINISH_ONLY_WABA", IDS));
    await flush();

    expect(backendCalls()).toHaveLength(0);
    expect(hooks.state(1)).toBe(PARTIAL_MESSAGE);
    expectNormalButton("Intentar de nuevo");
  });

  it("CANCEL vuelve a idle sin llamar al backend", async () => {
    await startAndReceiveCode();
    emit(ORIGIN, message("CANCEL"));

    expect(backendCalls()).toHaveLength(0);
    expectNormalButton("Conectar WhatsApp");
  });

  it("ERROR muestra error fijo y no llama al backend", async () => {
    await startAndReceiveCode();
    emit(ORIGIN, message("ERROR", { error_message: "texto privado" }));

    expect(backendCalls()).toHaveLength(0);
    expectNormalButton("Intentar de nuevo");
  });

  it("origen inválido se ignora y el timeout libera el botón", async () => {
    await startAndReceiveCode();
    emit("https://evilfacebook.com", message("FINISH", IDS));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(backendCalls()).toHaveLength(0);
    expectNormalButton("Intentar de nuevo");
  });

  it("15 s de silencio liberan el botón sin llamar al backend", async () => {
    await startAndReceiveCode();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(backendCalls()).toHaveLength(0);
    expectNormalButton("Intentar de nuevo");
  });
});
