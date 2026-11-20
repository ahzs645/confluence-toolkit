export type Site = {
  origin: string;
  product?: 'jira';
  context: string;
  deployment: 'cloud' | 'data-center';
};

export type Binding = {
  tabId: number;
  documentId: string;
  site: Site;
  identity: { name: string; id: string; site: Site };
};

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number };

export type BridgeStatus = {
  state: 'off' | 'connecting' | 'on';
  allowWrites: boolean;
  access?: 'read' | 'edit' | 'write' | 'full';
  error?: string;
};

export type Session = { binding?: Binding; jiraBinding?: Binding; bridge: BridgeStatus };
