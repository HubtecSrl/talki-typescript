// Files in and out: uploads sent as `form` (multipart/form-data), downloads
// returned as a named `File`, and `toFile`, against a mocked `fetch`.

import { describe, expect, expectTypeOf, it } from "vitest";
import { filenameOf, formDataOf } from "../src/files.js";
import { ConflictError, type CreateDocumentParams, type Document, Talki, toFile } from "../src/index.js";
import { empty, envelope, html, json, make, Recorder, type Seen } from "./helpers.js";

const DOCUMENT_ID = "5d2e8b17-3c9a-4f60-b4e1-8a7c2d9f0e36";
const LOCATION_ID = "0b7d4e19-8a2c-4f61-9d3e-5c1a7b2f8e40";

const DOCUMENT: Document = {
  id: DOCUMENT_ID,
  location_id: LOCATION_ID,
  title: "menu.pdf",
  source: "file",
  mime_type: "application/pdf",
  size_bytes: 8,
  chunk_count: 0,
  file_available: false,
  status: "processing",
  status_error: null,
  enabled: true,
  faq: false,
  copy_group_id: null,
  created_at: "2026-10-28T09:12:40Z",
  updated_at: "2026-10-28T09:12:40Z",
} as Document;

/** The `file` part of a request's form. */
function fileOf(request: Seen | undefined): File {
  const file = request?.form?.get("file");
  if (!(file instanceof File)) throw new Error("no file in the form");
  return file;
}

function pdf(): File {
  return new File(["%PDF-1.7"], "menu.pdf", { type: "application/pdf" });
}

describe("an upload", () => {
  it("sends a form as multipart/form-data, a File under its name and an array one field per item", async () => {
    const recorder = new Recorder(json(202, DOCUMENT));
    const document = await make(recorder).documents.create({
      form: { file: pdf(), location_ids: ["l2", "l3"] },
      location_id: LOCATION_ID,
    });
    expect(document.status).toBe("processing");
    const [request] = recorder.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url.pathname).toBe("/v1/documents");
    expect(request?.url.searchParams.get("location_id")).toBe(LOCATION_ID);
    // fetch writes the Content-Type, with the boundary.
    expect(request?.headers.has("Content-Type")).toBe(false);
    expect(request?.headers.get("Idempotency-Key")).toBeTruthy();
    const file = fileOf(request);
    expect([file.name, file.type, await file.text()]).toEqual(["menu.pdf", "application/pdf", "%PDF-1.7"]);
    expect(request?.form?.getAll("location_ids")).toEqual(["l2", "l3"]);
  });

  it("goes out as a real multipart body", async () => {
    let sent = "";
    let type = "";
    const recorder = new Recorder(async (_seen, init) => {
      const request = new Request("https://api.talki.it/v1/documents", { method: "POST", body: init.body ?? null });
      type = request.headers.get("content-type") ?? "";
      sent = await request.text();
      return json(202, DOCUMENT);
    });
    await make(recorder).documents.create({ form: { file: pdf() } });
    expect(type).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent).toContain('Content-Disposition: form-data; name="file"; filename="menu.pdf"');
    expect(sent).toContain("%PDF-1.7");
  });

  it("replaces a file, with its query", async () => {
    const recorder = new Recorder(json(202, DOCUMENT));
    await make(recorder).documents.replace(DOCUMENT_ID, { form: { file: pdf() }, also: "copies" });
    const [request] = recorder.requests;
    expect([request?.method, request?.url.pathname, request?.url.search]).toEqual([
      "PUT",
      `/v1/documents/${DOCUMENT_ID}`,
      "?also=copies",
    ]);
    expect(fileOf(request).name).toBe("menu.pdf");
  });

  it("is sent again, the same form with the same key, after a gateway's 503", async () => {
    const sleeps: number[] = [];
    const recorder = new Recorder(html(503, "<html>busy</html>"), json(202, DOCUMENT));
    await make(recorder, { sleeps }).documents.create({ form: { file: pdf() } });
    expect(recorder.requests).toHaveLength(2);
    const [first, second] = recorder.requests;
    expect(second?.headers.get("Idempotency-Key")).toBe(first?.headers.get("Idempotency-Key"));
    expect(fileOf(second).name).toBe("menu.pdf");
    expect(sleeps).toHaveLength(1);
  });

  it("refuses a Blob without a name, bytes, or a body and a form together, before sending", async () => {
    const recorder = new Recorder(json(202, DOCUMENT));
    const client = make(recorder);
    await expect(client.documents.create({ form: { file: new Blob(["x"]) } })).rejects.toThrow(/needs a name/);
    await expect(client.documents.create({ form: { file: new Uint8Array([1]) as unknown as Blob } })).rejects.toThrow(
      /is bytes/,
    );
    await expect(
      client.documents.create({ body: { title: "t", body: "b" }, form: { file: pdf() } } as never),
    ).rejects.toThrow(/a body or a form, not both/);
    await expect(client.documents.create({} as never)).rejects.toThrow(/needs a body or a form/);
    expect(recorder.requests).toHaveLength(0);
  });

  it("types one or the other", () => {
    expectTypeOf<{ form: { file: File } }>().toExtend<CreateDocumentParams>();
    expectTypeOf<{ body: { title: string; body: string } }>().toExtend<CreateDocumentParams>();
    expectTypeOf<{ body: { source: "website"; url: string } }>().toExtend<CreateDocumentParams>();
    expectTypeOf<{
      body: { title: string; body: string };
      form: { file: File };
    }>().not.toExtend<CreateDocumentParams>();
    expectTypeOf<{ form: { file: Uint8Array } }>().not.toExtend<CreateDocumentParams>();
  });
});

describe("a note or a website", () => {
  it("is sent as JSON", async () => {
    const recorder = new Recorder(json(202, { ...DOCUMENT, source: "text" }));
    await make(recorder).documents.create({ body: { title: "Is there parking?", body: "Yes, behind the salon." } });
    const [request] = recorder.requests;
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    expect(request?.form).toBeNull();
    expect(JSON.parse(request?.body ?? "")).toEqual({ title: "Is there parking?", body: "Yes, behind the salon." });
  });

  it("reports a document not ready as a ConflictError", async () => {
    const recorder = new Recorder(envelope(409, "conflict", "document_not_ready"));
    const error = await make(recorder, { maxRetries: 0 })
      .documents.replace(DOCUMENT_ID, { body: { body: "New text." } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("document_not_ready");
    expect(recorder.requests).toHaveLength(1);
  });

  it("drops a website's page by both ids", async () => {
    const recorder = new Recorder(empty(204));
    expect(await make(recorder).documents.deletePage(DOCUMENT_ID, "p/1", { also: "copies" })).toBe(undefined);
    expect(recorder.requests[0]?.url.pathname).toBe(`/v1/documents/${DOCUMENT_ID}/pages/p%2F1`);
    expect(recorder.requests[0]?.url.search).toBe("?also=copies");
  });
});

describe("a download", () => {
  it("is a File named as the answer names it", async () => {
    const recorder = new Recorder(
      new Response("%PDF-1.7", {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="listino caff?.pdf"; filename*=UTF-8''listino%20caff%C3%A8.pdf`,
        },
      }),
    );
    const file = await make(recorder).documents.getFile(DOCUMENT_ID);
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("listino caffè.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("%PDF-1.7");
    expectTypeOf(file).toEqualTypeOf<Blob>();
  });

  it("is a Blob when the answer names no file", async () => {
    const recorder = new Recorder(new Response("a,b", { status: 200, headers: { "content-type": "text/csv" } }));
    const file = await make(recorder).documents.getFile(DOCUMENT_ID);
    expect(file).toBeInstanceOf(Blob);
    expect(file).not.toBeInstanceOf(File);
    expect(file.type).toBe("text/csv");
  });
});

describe("toFile", () => {
  it("names bytes, text and a Blob", async () => {
    const bytes = await toFile(new TextEncoder().encode("hello"), "a.txt");
    expect([bytes.name, bytes.type, await bytes.text()]).toEqual(["a.txt", "", "hello"]);
    const text = await toFile("ciao", "b.txt", { type: "text/plain" });
    expect([text.name, text.type, await text.text()]).toEqual(["b.txt", "text/plain", "ciao"]);
    const blob = await toFile(new Blob(["x"], { type: "text/csv" }), "c.csv");
    expect([blob.name, blob.type]).toEqual(["c.csv", "text/csv"]);
    const buffer = await toFile(new Uint8Array([1, 2, 3]).buffer, "d.bin");
    expect(new Uint8Array(await buffer.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reads a stream to its end", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("one,"));
        controller.enqueue(encoder.encode("two"));
        controller.close();
      },
    });
    expect(await (await toFile(stream, "s.csv")).text()).toBe("one,two");
    async function* chunks() {
      yield encoder.encode("a");
      yield "b";
    }
    expect(await (await toFile(chunks(), "i.txt")).text()).toBe("ab");
  });

  it("needs a name and something to read", async () => {
    await expect(toFile("x", " ")).rejects.toThrow(TypeError);
    await expect(toFile(42 as never, "n.txt")).rejects.toThrow(TypeError);
  });

  it("makes what an upload sends", async () => {
    const recorder = new Recorder(json(202, DOCUMENT));
    await new Talki({ apiKey: "k", fetch: recorder.fetch }).documents.create({
      form: { file: await toFile(new TextEncoder().encode("a,b"), "prices.csv") },
    });
    expect(fileOf(recorder.requests[0]).name).toBe("prices.csv");
  });
});

describe("formDataOf", () => {
  it("writes each kind of value as text, and leaves out what is unset", () => {
    const at = new Date(Date.UTC(2026, 10, 2, 9, 30));
    const data = formDataOf({ n: 3, yes: true, at, none: null, gone: undefined, list: ["a", null, "b"] });
    expect([...data.entries()]).toEqual([
      ["n", "3"],
      ["yes", "true"],
      ["at", "2026-11-02T09:30:00.000Z"],
      ["list", "a"],
      ["list", "b"],
    ]);
  });

  it("refuses what it cannot send as a field", () => {
    expect(() => formDataOf({ nested: { a: 1 } })).toThrow(TypeError);
    expect(() => formDataOf(new FormData())).toThrow(TypeError);
    expect(() => formDataOf(null as never)).toThrow(TypeError);
  });
});

describe("filenameOf", () => {
  it("reads filename* before filename, and either alone", () => {
    expect(filenameOf(`attachment; filename="a.pdf"; filename*=UTF-8''b%20%C3%A8.pdf`)).toBe("b è.pdf");
    expect(filenameOf('attachment; filename="say \\"hi\\".txt"')).toBe('say "hi".txt');
    expect(filenameOf("attachment; filename=plain.csv")).toBe("plain.csv");
    expect(filenameOf("attachment; FILENAME*=utf-8''x.txt")).toBe("x.txt");
  });

  it("falls back to filename when filename* cannot be read", () => {
    expect(filenameOf(`attachment; filename="ok.pdf"; filename*=UTF-8''bad%E0%A4.pdf`)).toBe("ok.pdf");
    expect(filenameOf(`attachment; filename="ok.pdf"; filename*=ISO-8859-1''caf%E8.pdf`)).toBe("ok.pdf");
  });

  it("keeps the name, never a directory", () => {
    expect(filenameOf('attachment; filename="../../etc/passwd"')).toBe("passwd");
    expect(filenameOf("attachment; filename*=UTF-8''..%2F..%2Fx.txt")).toBe("x.txt");
    expect(filenameOf('attachment; filename="a\\\\b.txt"')).toBe("b.txt");
    expect(filenameOf('attachment; filename=".."')).toBeNull();
  });

  it("is null when nothing is named", () => {
    expect(filenameOf(null)).toBeNull();
    expect(filenameOf("attachment")).toBeNull();
    expect(filenameOf('attachment; filename=""')).toBeNull();
  });
});
