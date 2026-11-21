/** One page the app serves, and what it shows once hydrated. */
export interface PageCase {
  readonly path: string;
  /** Its one <h1>. */
  readonly heading: string;
  /** Its document title, where the page sets one. */
  readonly title?: string;
  /** Whether the shell's navigation is around it. */
  readonly shell: boolean;
  readonly status: number;
  /** Console errors it logs by design: a failed status, React's placeholder for a server error
   * (#441), a fixture's own error. */
  readonly logs?: readonly RegExp[];
}

const FAILED_LOAD = /^Failed to load resource: the server responded with a status of (404|500)/;
const SERVER_ERROR = /^Error: Minified React error #441;/;

/** "Every page" (T19): the shell's four, the ping page, an unknown address, and the end-to-end
 * build's fixture pages (scripts/e2e-stack.sh), which reach the not-found and error screens the
 * app ships no way into. Error screens are drawn in the browser, after an empty page from the
 * server, so each is checked once hydrated. */
export const PAGES: readonly PageCase[] = [
  { path: '/', heading: 'Inbox', title: 'Inbox · Instante', shell: true, status: 200 },
  { path: '/resumes', heading: 'Resumes', title: 'Resumes · Instante', shell: true, status: 200 },
  { path: '/applied', heading: 'Applied', title: 'Applied · Instante', shell: true, status: 200 },
  {
    path: '/settings',
    heading: 'Settings',
    title: 'Settings · Instante',
    shell: true,
    status: 200,
  },
  { path: '/ping', heading: 'Ping', title: 'Ping · Instante', shell: true, status: 200 },
  {
    path: '/no-such-page',
    heading: 'Page not found',
    title: 'Not found · Instante',
    shell: false,
    status: 404,
    logs: [FAILED_LOAD],
  },
  {
    path: '/e2e/not-found',
    heading: 'Page not found',
    shell: true,
    status: 404,
    logs: [FAILED_LOAD],
  },
  {
    path: '/e2e/shell-error',
    heading: 'Something went wrong',
    title: 'Error · Instante',
    shell: true,
    status: 500,
    logs: [FAILED_LOAD, SERVER_ERROR],
  },
  {
    path: '/e2e/root-error',
    heading: 'Something went wrong',
    title: 'Error · Instante',
    shell: false,
    status: 500,
    logs: [FAILED_LOAD, SERVER_ERROR],
  },
  {
    path: '/e2e/metadata-error',
    heading: 'Something went wrong',
    title: 'Error · Instante',
    shell: true,
    status: 200,
    logs: [SERVER_ERROR],
  },
];
