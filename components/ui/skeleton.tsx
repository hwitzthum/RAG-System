type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className = "h-4 w-full" }: SkeletonProps) {
  return <div className={`animate-pulse rounded-md bg-[var(--accent-soft)] ${className}`} />;
}
