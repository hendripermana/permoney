import {
  IconTrash,
  IconTag,
  IconX,
  IconBuildingStore,
  IconWallet,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarImage } from "@/components/ui/avatar"

interface CategoryOption {
  id: string
  name: string
  icon?: string | null
  color?: string | null
}

interface MerchantOption {
  id: string
  name: string
  logoUrl?: string | null
}

interface AccountOption {
  id: string
  name: string
  type: string
}

interface TransactionBulkFABProps {
  selectedCount: number
  onClearSelection: () => void
  onDelete: () => void
  onChangeCategory: (categoryId: string) => void
  onChangeMerchant: (merchantId: string) => void
  onChangeAccount: (accountId: string) => void
  categories: CategoryOption[]
  merchants: MerchantOption[]
  accounts: AccountOption[]
}

export function TransactionBulkFAB({
  selectedCount,
  onClearSelection,
  onDelete,
  onChangeCategory,
  onChangeMerchant,
  onChangeAccount,
  categories,
  merchants,
  accounts,
}: TransactionBulkFABProps) {
  if (selectedCount === 0) return null

  return (
    <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 animate-in items-center gap-4 rounded-full border border-border bg-background px-4 py-3 shadow-xl transition-all slide-in-from-bottom-5 md:bottom-12">
      <div className="flex items-center gap-2 border-r pr-4 text-sm font-medium">
        <span className="flex size-6 items-center justify-center rounded-full bg-primary/20 text-xs text-primary">
          {selectedCount}
        </span>
        <span className="hidden sm:inline">Transactions Selected</span>
        <span className="sm:hidden">Selected</span>
        <button
          onClick={onClearSelection}
          className="ml-2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <IconX size={16} />
        </button>
      </div>

      <div className="flex items-center gap-2">
        {/* CATEGORY DROPDOWN */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <IconTag size={16} />
              <span className="hidden sm:inline">Category</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="center"
            className="max-h-[300px] w-[200px] overflow-y-auto"
          >
            <DropdownMenuLabel>Select Category</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {categories.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onClick={() => onChangeCategory(c.id)}
                className="flex cursor-pointer items-center gap-2"
              >
                <div
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color || "#ccc" }}
                />
                <span className="truncate">{c.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* MERCHANT DROPDOWN */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <IconBuildingStore size={16} />
              <span className="hidden sm:inline">Merchant</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="center"
            className="max-h-[300px] w-[200px] overflow-y-auto"
          >
            <DropdownMenuLabel>Select Merchant</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {merchants.map((m) => (
              <DropdownMenuItem
                key={m.id}
                onClick={() => onChangeMerchant(m.id)}
                className="flex cursor-pointer items-center gap-2"
              >
                {m.logoUrl ? (
                  <Avatar className="size-5 shrink-0 rounded-sm">
                    <AvatarImage
                      src={m.logoUrl}
                      alt={m.name}
                      className="object-cover"
                    />
                  </Avatar>
                ) : (
                  <div className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-bold text-muted-foreground uppercase">
                    {m.name.slice(0, 2)}
                  </div>
                )}
                <span className="truncate">{m.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* ACCOUNT DROPDOWN */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <IconWallet size={16} />
              <span className="hidden sm:inline">Account</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="center"
            className="max-h-[300px] w-[200px] overflow-y-auto"
          >
            <DropdownMenuLabel>Move to Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {accounts.map((a) => (
              <DropdownMenuItem
                key={a.id}
                onClick={() => onChangeAccount(a.id)}
                className="flex cursor-pointer items-center gap-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{a.name}</span>
                  <span className="text-xs text-muted-foreground uppercase">
                    {a.type}
                  </span>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="destructive"
          size="sm"
          className="gap-2"
          onClick={onDelete}
        >
          <IconTrash size={16} />
          <span className="hidden sm:inline">Delete</span>
        </Button>
      </div>
    </div>
  )
}
