import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertResult } from "../../lib/types.js";
import { buildEmailMessage } from "../email.js";
import { escapeSlackMrkdwn, escapeTelegramHtml, isValidMailbox } from "../sanitize.js";
import { sendSlack } from "../slack.js";
import { sendTelegram, TELEGRAM_TEXT_LIMIT } from "../telegram.js";

const hostile = 'host</b>*_`\r\nInjected';
const alert: AlertResult = {
  type: "smart_failing",
  severity: "critical",
  title: hostile,
  message: hostile,
  evidence: {},
  recommendation: hostile,
};

afterEach(() => vi.unstubAllGlobals());

describe("notification sanitization", () => {
  it("escapes Telegram HTML and normalizes attacker-controlled newlines", () => {
    expect(escapeTelegramHtml(hostile)).toBe("host&lt;/b&gt;*_` Injected");
  });

  it("escapes Slack control syntax and link delimiters", () => {
    expect(escapeSlackMrkdwn(hostile)).toBe("host&lt;/b&gt;\u2217\uFF3F\u02CB Injected");
  });

  it("serializes hostile Telegram fields without markup injection", async () => {
    let body = "";
    const fetchImpl = (async (_url: any, init: any) => { body = String(init.body); return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
    const resolveEndpoint = (async () => [{ address: "203.0.113.10", family: 4 }]) as any;
    expect(await sendTelegram("fake-token", "1", [alert], [], hostile, { allowInsecure: false, allowedOrigins: [] }, fetchImpl, resolveEndpoint)).toBe(true);
    const payload = JSON.parse(body);
    expect(payload.text).not.toContain("host</b>");
    expect(payload.text).toContain("&lt;/b&gt;");
  });

  it("keeps a large Telegram batch within the limit as complete HTML", async () => {
    let body = "";
    const fetchImpl = (async (_url: any, init: any) => { body = String(init.body); return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
    const resolveEndpoint = (async () => [{ address: "203.0.113.10", family: 4 }]) as any;
    const large = Array.from({ length: 100 }, (_, index) => ({
      ...alert,
      title: `<title-${index}>`.repeat(100),
      recommendation: `recommendation-${index} & `.repeat(200),
    }));

    expect(await sendTelegram("fake-token", "1", large, large, hostile, { allowInsecure: false, allowedOrigins: [] }, fetchImpl, resolveEndpoint)).toBe(true);
    const text = JSON.parse(body).text as string;
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect((text.match(/<b>/g) ?? []).length).toBe((text.match(/<\/b>/g) ?? []).length);
    expect(text).not.toMatch(/&(?:a|am|amp|l|lt|g|gt|q|qu|quo|quot)?$/);
  });

  it("serializes hostile Slack fields without raw mrkdwn controls", async () => {
    let body = "";
    const fetchImpl = (async (_url: any, init: any) => { body = String(init.body); return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
    const resolveEndpoint = (async () => [{ address: "203.0.113.10", family: 4 }]) as any;
    expect(await sendSlack("https://hooks.example.invalid", [alert], [], hostile, { allowInsecure: false, allowedOrigins: [] }, fetchImpl, resolveEndpoint)).toBe(true);
    const payload = JSON.parse(body);
    const text = JSON.stringify(payload.blocks);
    expect(text).not.toContain("</b>");
    expect(text).toContain("&lt;/b&gt;");
    expect(text).toContain("\u2217");
  });

  it("refuses a Slack webhook aimed at a private/link-local address (SSRF)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as any;
    const resolveEndpoint = (async () => [{ address: "203.0.113.10", family: 4 }]) as any;
    const ok = await sendSlack("http://169.254.169.254/hook", [alert], [], "srv", { allowInsecure: false, allowedOrigins: [] }, fetchImpl, resolveEndpoint);
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects CRLF and invalid envelope recipients in email headers", () => {
    expect(isValidMailbox("ops@example.com")).toBe(true);
    expect(isValidMailbox("ops@example.com\r\nBcc: attacker@example.com")).toBe(false);
    expect(buildEmailMessage("ops@example.com", [alert], [], "node\r\nBcc: attacker@example.com")).toBeNull();
    expect(buildEmailMessage("bad recipient", [alert], [], "node-1")).toBeNull();
  });
});
