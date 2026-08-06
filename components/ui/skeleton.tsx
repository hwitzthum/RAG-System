type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className = "h-4 w-full" }: SkeletonProps) {
  return (
    <div className={`animate-shimmer bg-[var(--emphasis-soft)] ${className}`} />
  );
}
