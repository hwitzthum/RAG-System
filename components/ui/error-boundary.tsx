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
        <div className="surface-card flex min-h-[200px] items-center justify-center p-10">
          <div>
            <hr className="rule-gold mb-6 w-12" />
            <p className="display-4">Something went wrong</p>
            <p className="fg-secondary mt-3 text-sm">
              An unexpected error occurred.
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="btn-primary mt-6 px-4 py-2 text-[10px]"
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
