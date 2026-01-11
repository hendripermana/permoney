# frozen_string_literal: true

module SimplefinItems
  module MapsHelper
    extend ActiveSupport::Concern

    # Build per-item maps consumed by the SimpleFin card partial.
    # Accepts a single SimplefinItem or a collection.
    def build_simplefin_maps_for(items)
      items = Array(items).compact
      return if items.empty?

      @simplefin_sync_stats_map ||= {}
      @simplefin_has_unlinked_map ||= {}
      @simplefin_unlinked_count_map ||= {}
      @simplefin_duplicate_only_map ||= {}
      @simplefin_show_relink_map ||= {}

      family_ids = items.map(&:family_id).uniq
      families_with_manuals = Account
        .visible_manual
        .where(family_id: family_ids)
        .distinct
        .pluck(:family_id)
        .to_set

      unlinked_counts = SimplefinAccount
        .where(simplefin_item_id: items.map(&:id))
        .left_joins(:account, :account_provider)
        .where(accounts: { id: nil }, account_providers: { id: nil })
        .group(:simplefin_item_id)
        .count

      items.each do |item|
        latest_sync = if item.syncs.loaded?
          item.syncs.max_by(&:created_at)
        else
          item.syncs.ordered.first
        end
        stats = latest_sync&.sync_stats || {}
        @simplefin_sync_stats_map[item.id] = stats

        @simplefin_has_unlinked_map[item.id] = families_with_manuals.include?(item.family_id)
        @simplefin_unlinked_count_map[item.id] = unlinked_counts[item.id] || 0
        @simplefin_duplicate_only_map[item.id] = compute_duplicate_only_flag(stats)

        begin
          unlinked_count = @simplefin_unlinked_count_map[item.id] || 0
          manuals_exist = @simplefin_has_unlinked_map[item.id]
          sfa_any = if item.simplefin_accounts.loaded?
            item.simplefin_accounts.any?
          else
            item.simplefin_accounts.exists?
          end
          @simplefin_show_relink_map[item.id] = (unlinked_count.to_i == 0 && manuals_exist && sfa_any)
        rescue StandardError => e
          Rails.logger.warn("SimpleFin card: CTA computation failed for item #{item.id}: #{e.class} - #{e.message}")
          @simplefin_show_relink_map[item.id] = false
        end
      end

      @simplefin_sync_stats_map ||= {}
      @simplefin_has_unlinked_map ||= {}
      @simplefin_unlinked_count_map ||= {}
      @simplefin_duplicate_only_map ||= {}
      @simplefin_show_relink_map ||= {}
    end

    private
      def compute_duplicate_only_flag(stats)
        errs = Array(stats && stats["errors"]).map do |entry|
          if entry.is_a?(Hash)
            entry["message"] || entry[:message]
          else
            entry.to_s
          end
        end
        errs.present? && errs.all? { |msg| msg.to_s.downcase.include?("duplicate upstream account detected") }
      rescue
        false
      end
  end
end
