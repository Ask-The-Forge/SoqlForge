/**
 * Top-level error boundary so an uncaught render error doesn't blank the page.
 *
 * Renders the message + stack inline; this is dev-friendly and good enough for
 * a single-developer desktop app. (For production polish we'd hide the stack
 * and add a "report" affordance.)
 */

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: "" };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string | null }): void {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, errorInfo);
    this.setState({ info: errorInfo.componentStack ?? "" });
  }

  reset = () => this.setState({ error: null, info: "" });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full w-full flex flex-col bg-zinc-950 text-zinc-100 p-6 overflow-auto">
        <h1 className="text-lg font-semibold text-red-400 mb-2">
          SoqlForge crashed
        </h1>
        <button
          onClick={this.reset}
          className="self-start mb-4 px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm"
        >
          Reset
        </button>
        <pre className="text-xs font-mono text-red-300 bg-red-950/30 border border-red-900/50 rounded p-3 whitespace-pre-wrap break-words mb-4">
          {this.state.error.name}: {this.state.error.message}
          {"\n\n"}
          {this.state.error.stack}
        </pre>
        {this.state.info && (
          <pre className="text-xs font-mono text-zinc-400 bg-zinc-900/40 border border-zinc-800 rounded p-3 whitespace-pre-wrap break-words">
            {this.state.info}
          </pre>
        )}
      </div>
    );
  }
}
