import { api, post } from "./api";

export type StudioAttachment = {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  kind: "image" | "document" | "video" | "audio";
};
export type StudioUploadPolicy = {
  enabled: boolean;
  max_files: number;
  max_size_bytes: number;
  accept: string[];
};
export type StudioOperation =
  "generate" | "remove_background" | "erase" | "edit" | "expand" | "upscale";

export const uploadStudioAttachment = (file: File, signal?: AbortSignal) => {
  const data = new FormData();
  data.append("file", file);
  return api<StudioAttachment>("/api/studio/attachments", {
    method: "POST",
    body: data,
    signal,
  });
};

export const removeStudioAttachment = (id: string) =>
  api(`/api/studio/attachments/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const reuseStudioAsset = (id: string) =>
  post<StudioAttachment>(
    `/api/studio/assets/${encodeURIComponent(id)}/reference`,
    {},
  );

export const studioAttachmentUrl = (id: string) =>
  `/api/studio/attachments/${encodeURIComponent(id)}`;
