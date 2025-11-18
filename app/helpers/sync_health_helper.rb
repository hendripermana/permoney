module SyncHealthHelper
  def sync_health_state
    fam = Current.family
    return {} unless fam

    # Cache briefly to avoid heavy queries on dashboards
    Rails.cache.fetch(fam.build_cache_key("sync_health_banner"), expires_in: 1.minute) do
      account_ids = fam.accounts.pluck(:id)
      scope = Sync.where(
        "(syncable_type = ? AND syncable_id = ?) OR (syncable_type = ? AND syncable_id IN (?))",
        "Family", fam.id, "Account", account_ids
      )

      {
        pending: scope.where(status: "pending").count,
        syncing: scope.where(status: "syncing").count,
        stale: scope.where(status: "stale").count,
        failed: scope.where(status: "failed").count
      }
    end
  end
end
