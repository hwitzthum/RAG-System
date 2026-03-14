"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
};

type State = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="surface-card flex min-h-[200px] items-center justify-center rounded-2xl p-8">
          <div className="text-center">
            <p className="fg-primary text-sm font-medium">Something went wrong</p>
            <p className="fg-muted mt-1 text-xs">An unexpected error occurred.</p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="btn-primary mt-3 rounded-2xl px-3 py-1.5 text-xs font-medium active:scale-[0.98]"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
