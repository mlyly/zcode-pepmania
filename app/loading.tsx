import {Skeleton} from "@/components/ui/skeleton";

/**
 * Route-transition fallback. The shell mimics the page layouts (max-w-3xl
 * header + content column) so navigation never flashes an empty viewport —
 * important on slow cold-starts of the installed PWA.
 */
export default function Loading() {
    return (
        <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12" aria-busy="true" aria-live="polite">
            <header className="flex w-full max-w-3xl flex-col gap-3">
                <Skeleton className="h-8 w-44"/>
                <Skeleton className="h-4 w-full max-w-xl"/>
            </header>
            <main className="flex w-full max-w-3xl flex-col gap-4">
                <Skeleton className="h-32 w-full rounded-xl"/>
                <Skeleton className="h-56 w-full rounded-xl"/>
            </main>
        </div>
    );
}
