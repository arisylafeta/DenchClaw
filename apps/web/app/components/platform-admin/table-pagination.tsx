import { Button } from "@/app/components/platform-admin/ui/button";

interface TablePaginationProps {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
}

export function TablePagination({
  page,
  pageSize,
  totalCount,
  totalPages,
  itemLabel,
  onPageChange,
}: TablePaginationProps) {
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount);

  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <p>
        Showing {from}-{to} of {totalCount} {itemLabel}
        {totalCount === 1 ? "" : "s"} · Page {page} of {totalPages}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
