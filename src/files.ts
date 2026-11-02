/**
 * Files in and out: `toFile`, which makes the `File` an upload sends; the
 * `multipart/form-data` body a `form` becomes; and the name a download
 * carries in `Content-Disposition`.
 *
 *     import { readFile } from "node:fs/promises";
 *     import { Talki, toFile } from "@hubtec/talki";
 *
 *     const file = await toFile(await readFile("menu.pdf"), "menu.pdf");
 *     const document = await talki.documents.create({ form: { file } });
 *
 * Built on the global `File`, `Blob` and `FormData`, so it runs on Node 20 or
 * later, Bun, Deno and edge runtimes alike.
 */

/** What `toFile` reads: bytes, text, a `Blob`, or a stream of bytes (a web `ReadableStream`, or Node's `fs.createReadStream()`). */
export type FileSource =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>;

export interface ToFileOptions {
  /**
   * The file's media type (`application/pdf`). Defaults to the `Blob`'s own,
   * or none, in which case the API goes by the name's extension.
   */
  type?: string | undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/**
 * A `File` named ``name`` with ``source``'s bytes, to send in a `form`. The
 * API reads the name: an upload's becomes the document's title, and its
 * extension tells the file's type when `type` is not given.
 *
 *     await toFile(await readFile("menu.pdf"), "menu.pdf");                // Node, Bun: a Buffer
 *     await toFile(await fs.openAsBlob("menu.pdf"), "menu.pdf");           // Node: a Blob
 *     await toFile(createReadStream("prices.csv"), "prices.csv");          // Node: a stream
 *     await toFile("Open 9 to 18.", "hours.txt", { type: "text/plain" });  // text, as UTF-8
 *
 * A `File` you already have (from a browser's `<input type="file">`, or
 * `Bun.file()`) can be sent as it is.
 */
export async function toFile(source: FileSource, name: string, options: ToFileOptions = {}): Promise<File> {
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("toFile needs the file's name.");
  let parts: BlobPart[];
  let type = options.type;
  if (source instanceof Blob) {
    parts = [source];
    type ??= source.type;
  } else if (typeof source === "string" || source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    parts = [source as BlobPart];
  } else if (typeof ReadableStream === "function" && source instanceof ReadableStream) {
    parts = [await new Response(source).blob()];
  } else if (isAsyncIterable(source)) {
    parts = [];
    for await (const chunk of source) parts.push(chunk as BlobPart);
  } else {
    throw new TypeError("toFile reads a Blob, bytes, text or a stream of bytes.");
  }
  return new File(parts, name, type ? { type } : {});
}

function fileName(value: Blob): string {
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function fieldValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * The `multipart/form-data` body a method's `form` is sent as: a `File` as a
 * file part under its name, an array as one field per item, a `null` or
 * `undefined` left out, a `Date` as its ISO string, anything else as its text. `fetch` writes the
 * boundary, and can send it again on a retry.
 */
export function formDataOf(form: object): FormData {
  if (typeof form !== "object" || form === null || Array.isArray(form) || form instanceof FormData) {
    throw new TypeError("form must be an object of fields, such as { file }.");
  }
  const data = new FormData();
  for (const [field, value] of Object.entries(form)) {
    for (const each of Array.isArray(value) ? value : [value]) {
      if (each === undefined || each === null) continue;
      if (each instanceof Blob) {
        const name = fileName(each);
        if (!name.trim()) {
          // The API reads the name, and goes by its extension for the type:
          // a nameless Blob would arrive as "blob".
          throw new TypeError(`form.${field} needs a name: pass a File, or toFile(data, name).`);
        }
        data.append(field, each, name);
      } else if (each instanceof ArrayBuffer || ArrayBuffer.isView(each)) {
        throw new TypeError(`form.${field} is bytes: pass a File, or toFile(data, name).`);
      } else if (each instanceof Date) {
        data.append(field, fieldValue(each));
      } else if (typeof each === "object") {
        throw new TypeError(`form.${field} must be a File, text, a number or a boolean.`);
      } else {
        data.append(field, fieldValue(each));
      }
    }
  }
  return data;
}

/**
 * The file name a `Content-Disposition` header gives (`filename*` before
 * `filename`), less any directory, or null when it names none. Safe to use as
 * a name, not as a path: check it before writing it to disk.
 */
export function filenameOf(disposition: string | null | undefined): string | null {
  if (!disposition) return null;
  let name: string | null = null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^']*)'[^']*'([^;]*)/i.exec(disposition);
  if (extended?.[2] !== undefined && /^utf-8$/i.test(extended[1]?.trim() ?? "")) {
    try {
      name = decodeURIComponent(extended[2].trim());
    } catch {
      name = null;
    }
  }
  if (name === null) {
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(disposition);
    const quoted = plain?.[1];
    name = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : (plain?.[2]?.trim() ?? null);
  }
  const base = name?.split(/[/\\]/).pop()?.trim() ?? "";
  return base === "" || base === "." || base === ".." ? null : base;
}
