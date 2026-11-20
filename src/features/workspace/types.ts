export type Collection<T> = { results: T[]; nextCursor?: string; nextStart?: number };
export type Page = {
  id: string;
  title: string;
  type?: string;
  spaceId?: string;
  space?: { key: string };
  parentId?: string;
  version: { number: number };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; editui?: string; edituiv2?: string };
};
export type SearchItem = { title: string; url?: string; excerpt?: string; content?: { id: string; type?: string } };
export type Space = { id: string | number; key: string; name: string };
export type RelatedItem = {
  id: string | number;
  title?: string;
  name?: string;
  type?: string;
  prefix?: string;
  downloadUrl?: string;
  body?: { storage?: { value?: string } };
};
