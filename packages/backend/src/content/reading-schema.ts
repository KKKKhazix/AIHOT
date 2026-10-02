import { z } from "zod";

export const BodySelectionSchema = z.object({
  confirmed: z.boolean(), keepBlockIds: z.array(z.string()).max(500), reason: z.string().max(1000),
}).strict();

export const ImageReadingSchema = z.object({
  imageId: z.string(),
  role: z.enum(["notice", "table", "chart", "photo", "decorative", "unknown"]),
  status: z.enum(["read", "ignored", "unreadable"]),
  markdown: z.string().max(40_000),
  reason: z.string().max(1000),
  uncertainties: z.array(z.string().max(500)).max(100),
  regions: z.array(z.object({ tile: z.number().int().min(0).max(8), text: z.string().max(1000) }).strict()).max(200),
}).strict();

export const ImageBatchSchema = z.object({ images: z.array(ImageReadingSchema).min(1).max(4) }).strict();
export type ImageReading = z.infer<typeof ImageReadingSchema>;
