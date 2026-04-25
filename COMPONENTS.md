# Installed UI Components (shadcn/ui)

This file tracks all shadcn/ui primitives currently installed in the project. Agent must check this list before attempting to add or build new UI components.

## Directory Structure

- **Primitives**: `@/components/ui/*.tsx`
- **Blocks/Composed**: `@/components/blocks/*.tsx`

## Currently Installed Components

_Legend: [Component Name] - [Source Path]_

### Core Primitives

- [x] **Button** - `@/components/ui/button.tsx`
- [x] **Input** - `@/components/ui/input.tsx`
- [x] **Card** - `@/components/ui/card.tsx`
- [x] **Dialog** (Modal) - `@/components/ui/dialog.tsx`
- [x] **Dropdown Menu** - `@/components/ui/dropdown-menu.tsx`
- [x] **Form** (TanStack Form compatible) - `@/components/ui/form.tsx`
- [x] **Table** (TanStack Table compatible) - `@/components/ui/table.tsx`
- [x] **Checkbox** - `@/components/ui/checkbox.tsx`
- [x] **Label** - `@/components/ui/label.tsx`
- [x] **Sidebar** - `@/components/ui/sidebar.tsx`
- [x] **Tooltip** - `@/components/ui/tooltip.tsx` (Wrapped in TooltipProvider)

### Feedback & Overlays

- [x] **Toast** - `@/components/ui/use-toast.ts` & `toaster.tsx`
- [x] **Skeleton** - `@/components/ui/skeleton.tsx`

### Layout & Navigation

- [x] **Separator** - `@/components/ui/separator.tsx`
- [x] **TransactionFormModal** - `@/components/transaction-form-modal.tsx` (Split-aware transaction engine)
- [x] **TransactionBulkFab** - `@/components/transaction-bulk-fab.tsx` (Mass mutation gateway)
- [x] **TransactionFilterPanel** - `@/components/transaction-filter-panel.tsx` (URL-state synced search/filter)
- [x] **SiteHeader** - `@/components/site-header.tsx`
- [x] **AppSidebar** - `@/components/app-sidebar.tsx`

---

## Instructions for Agents

1. **Check before adding**: If a required component is NOT on this list, add it using:
   `vp dlx shadcn@latest add [component-name]`
2. **Update this file**: After successfully adding a new component via CLI, you MUST update this `COMPONENTS.md` file by adding it to the appropriate section.
3. **Naming Convention**: Always use the default shadcn naming for files and exports.

### Community Blocks

- [x] **Dashboard Shell** - `@shadcnblocks/dashboard-shell`
- [x] **Metric Cards** - `@shadcnblocks/metrics`
- [x] **Advanced Table** - `@kiboui/data-table`
- [x] **Animated Globe** - `@magicui/globe`

## Functional Page Modules

- [x] **Import & Rules Hub** - `src/routes/import.tsx` (Client-side CSV Ingestion + Pattern Matching)
- [x] **Double-Entry Ledger** - `src/routes/transactions.tsx` (TanStack DB Reactive View + Bulk Mutations)
- [x] **Finance Dashboard** - `src/routes/dashboard.tsx` (Real-time account & expense KPIs)
