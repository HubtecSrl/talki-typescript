/**
 * Every page of a list, or every row: a cursor loop written once.
 *
 * A list method that takes `cursor` returns a `PagePromise`. Await it for the
 * first page; `for await` it for every row, page after page.
 *
 *     const page = await talki.calls.list({ limit: 50 });   // the first page
 *     for await (const call of talki.calls.list({ limit: 100 })) { … }
 *
 *     // A change feed: store each page's position, resume from it next time.
 *     for await (const page of talki.appointments.list({ cursor: stored }).iterPages()) {
 *       await save(page.data);
 *       stored = position(page, stored);
 *     }
 *
 * `next_cursor` comes back on a feed's last page too: it is a position, not a
 * promise of more, so a walk ends on `has_more` alone. Keep the filters the
 * same for a whole walk.
 */

import { TalkiError } from "./errors.js";

/** A page said `has_more` but gave no new `next_cursor` to ask for it. */
export class PaginationError extends TalkiError {
  override name = "PaginationError";
}

/** A list answer as the API sends it. */
export interface ListBody<T> {
  data: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/**
 * Where a change-feed walk stands after ``page``: its `nextCursor`, or
 * ``previous`` when the page carried none (a feed's page comes back empty).
 *
 * For change feeds only: a plain list's last page has a null `nextCursor`
 * although it holds rows, so this would hand back the cursor before it.
 */
export function position(page: Page<unknown>, previous: string | null = null): string | null {
  return page.nextCursor ?? previous;
}

/** The cursor for the page after ``page``, or null when there is none. */
function following(page: Page<unknown>, cursor: string | null): string | null {
  if (!page.hasMore) return null;
  const next = page.nextCursor;
  if (next === null || next === cursor) {
    // More promised and no way to ask for it: stop rather than loop forever.
    throw new PaginationError("The page says has_more but gives no new next_cursor.");
  }
  return next;
}

/**
 * One page of a list: its rows in `data`, `hasMore` and `nextCursor`.
 *
 * `for await` on a page yields its rows and those of every page after it,
 * fetched as the loop reaches them; `iterPages()` yields the pages. Either
 * starts again from this page each time. A page that fails throws its
 * `ApiError`, after the rows of those before it.
 */
export class Page<T> implements AsyncIterable<T> {
  readonly data: T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly #fetch: (cursor: string) => Promise<Page<T>>;
  readonly #cursor: string | null;

  /**
   * @param body - the list as the API answered it.
   * @param fetch - fetches the page at a cursor, with the same filters.
   * @param cursor - the cursor this page was fetched at, null for the first.
   */
  constructor(body: ListBody<T>, fetch: (cursor: string) => Promise<Page<T>>, cursor: string | null) {
    this.data = Array.isArray(body.data) ? body.data : [];
    this.hasMore = Boolean(body.has_more);
    this.nextCursor = typeof body.next_cursor === "string" ? body.next_cursor : null;
    this.#fetch = fetch;
    this.#cursor = cursor;
  }

  /** This page, then every page after it. */
  async *iterPages(): AsyncGenerator<Page<T>, void, undefined> {
    let page: Page<T> = this;
    while (true) {
      yield page;
      const next = following(page, page.#cursor);
      if (next === null) return;
      page = await this.#fetch(next);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for await (const page of this.iterPages()) {
      yield* page.data;
    }
  }

  get [Symbol.toStringTag](): string {
    return "Page";
  }
}

/**
 * What a list method returns, before any request: await it for the first
 * `Page`, or `for await` it for every row. The first page is fetched once,
 * when it is first awaited or iterated; until then nothing is sent, so a
 * refused first page throws from the `await` or the loop.
 */
export class PagePromise<T> implements PromiseLike<Page<T>>, AsyncIterable<T> {
  readonly #first: () => Promise<Page<T>>;
  #promise: Promise<Page<T>> | undefined;

  constructor(first: () => Promise<Page<T>>) {
    this.#first = first;
  }

  #get(): Promise<Page<T>> {
    this.#promise ??= this.#first();
    return this.#promise;
  }

  // biome-ignore lint/suspicious/noThenProperty: awaitable on purpose, like a Promise.
  then<A = Page<T>, B = never>(
    onfulfilled?: ((page: Page<T>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#get().then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<Page<T> | B> {
    return this.#get().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<Page<T>> {
    return this.#get().finally(onfinally);
  }

  /** The first page, then every page after it. */
  async *iterPages(): AsyncGenerator<Page<T>, void, undefined> {
    yield* (await this.#get()).iterPages();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    yield* await this.#get();
  }

  get [Symbol.toStringTag](): string {
    return "PagePromise";
  }
}
