type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className = "h-4 w-full" }: SkeletonProps) {
  return <div className={`rounded-md bg-zinc-200 animate-pulse ${className}`} />;
}
