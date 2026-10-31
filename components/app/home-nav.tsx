"use client";

import Link from "next/link";
import {Activity, CalendarCheck2, ChartSpline, ClipboardList, Menu, Pill, Settings} from "lucide-react";
import {useEffect, useRef, useState} from "react";

import {Button} from "@/components/ui/button";
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,} from "@/components/ui/dropdown-menu";

const links = [
    {href: "/schedules", label: "Schedules", icon: CalendarCheck2},
    {href: "/medications", label: "Medications", icon: Pill},
    {href: "/dose-logs", label: "Dose Log", icon: ClipboardList},
    {href: "/pharmacokinetics", label: "Chart", icon: ChartSpline},
    {href: "/measurements", label: "Metrics", icon: Activity},
    {href: "/settings", label: "Settings", icon: Settings},
] as const;

/**
 * Header navigation for the main page: the module links are shown inline
 * while they fit on one line and collapse into a hamburger dropdown as soon
 * as they don't. Fitting is measured against a hidden single-line copy of the
 * same buttons, so the breakpoint follows the real rendered width (webfont,
 * zoom, locale) instead of a hardcoded screen size.
 */
export function HomeNav() {
    const containerRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<HTMLDivElement>(null);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        const container = containerRef.current;
        const measure = measureRef.current;
        if (!container || !measure) return;

        const update = () => {
            // 1px tolerance for fractional layout widths.
            setCollapsed(measure.scrollWidth > container.clientWidth + 1);
        };

        update();
        const observer = new ResizeObserver(update);
        observer.observe(container);
        observer.observe(measure);
        // Font swaps change button widths without resizing either element.
        document.fonts.ready.then(update).catch(() => undefined);
        return () => observer.disconnect();
    }, []);

    const buttons = links.map(({href, label, icon: Icon}) => (
        <Button key={href} asChild variant="ghost" size="sm">
            <Link href={href}>
                <Icon className="size-4" aria-hidden/>
                {label}
            </Link>
        </Button>
    ));

    return (
        <div ref={containerRef} className="relative flex min-w-0 flex-1 justify-end">
            {/* Hidden single-line copy — measured, never interactive
                (visibility:hidden also removes it from the tab order). */}
            <div
                ref={measureRef}
                aria-hidden
                className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap items-center gap-1"
            >
                {buttons}
            </div>

            {collapsed ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Open navigation menu">
                            <Menu className="size-4" aria-hidden/>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                        {links.map(({href, label, icon: Icon}) => (
                            <DropdownMenuItem key={href} asChild>
                                <Link href={href}>
                                    <Icon className="size-4" aria-hidden/>
                                    {label}
                                </Link>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : (
                <nav className="flex flex-nowrap items-center gap-1">
                    {buttons}
                </nav>
            )}
        </div>
    );
}
