module SimplefinItems
  module MapsHelper
    def build_simplefin_maps_for(simplefin_items)
      item_ids = simplefin_items.map(&:id)
      return if item_ids.empty?

      # Build sync stats map from latest syncs
      # We fetch latest sync per item to avoid N+1 queries during iteration
      latest_syncs = Sync.where(syncable_type: "SimplefinItem", syncable_id: item_ids)
                         .select("DISTINCT ON (syncable_id) *")
                         .order("syncable_id, created_at DESC")
      
      @simplefin_sync_stats_map = latest_syncs.each_with_object({}) do |sync, map|
        map[sync.syncable_id] = sync.sync_stats
      end

      # Build unlinked count map
      # Count SimplefinAccounts without linked Account or AccountProvider
      @simplefin_unlinked_count_map = SimplefinAccount
        .where(simplefin_item_id: item_ids)
        .left_joins(:account, :account_provider)
        .where(accounts: { id: nil }, account_providers: { id: nil })
        .group(:simplefin_item_id)
        .count
    end
  end
end
