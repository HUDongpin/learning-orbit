export class MediaAttachmentLimitError extends Error {
  constructor() {
    super("MEDIA_ATTACHMENT_LIMIT");
    this.name = "MediaAttachmentLimitError";
  }
}

export class MediaSlotReservations {
  readonly #max: number;
  #known = new Set<string>();
  #inflight = 0;

  constructor(max = 4, initialMediaIds: Iterable<string> = []) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("MEDIA_SLOT_LIMIT_INVALID");
    this.#max = max;
    this.#known = new Set(initialMediaIds);
    if (this.#known.size > max) throw new Error("MEDIA_SLOT_LIMIT_INVALID");
  }

  get occupied(): number { return this.#known.size + this.#inflight; }

  remove(mediaId: string): void {
    this.#known.delete(mediaId);
  }

  async run<T extends Readonly<{ mediaId: string }>>(work: () => Promise<T>): Promise<T> {
    if (this.occupied >= this.#max) throw new MediaAttachmentLimitError();
    this.#inflight += 1;
    try {
      const result = await work();
      if (this.#known.has(result.mediaId)) throw new Error("MEDIA_ID_DUPLICATE");
      this.#known.add(result.mediaId);
      return result;
    } finally {
      this.#inflight -= 1;
    }
  }
}
