export interface WebServerDeps {
  baseDir: string;
}

export interface WebServerHandle {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

export interface WebServer {
  fetch: (req: Request) => Promise<Response>;
  listen(port?: number): Promise<WebServerHandle>;
}

export function createWebServer(_deps: WebServerDeps): WebServer {
  throw new Error("Not implemented");
}
