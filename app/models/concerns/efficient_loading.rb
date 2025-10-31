# Efficient Loading Concern
# Provides helper methods for preventing N+1 queries and optimizing database access
#
# Usage:
#   class Account < ApplicationRecord
#     include EfficientLoading
#
#     # Define efficient scopes
#     scope :with_entries, -> { includes(:entries) }
#     scope :with_full_associations, -> { with_entries_and_account }
#   end

module EfficientLoading
  extend ActiveSupport::Concern

  class_methods do
    # Efficiently load records with common associations
    # Prevents N+1 queries by preloading associations
    def with_common_associations
      includes(:family)
    end

    # Load records with counting associations efficiently
    # Uses counter caches when available
    def with_counts(*associations)
      associations.reduce(all) do |scope, association|
        counter_cache_column = "#{association}_count"

        if column_names.include?(counter_cache_column)
          # Use counter cache if available
          scope
        else
          # Fall back to left_joins and count
          scope.left_joins(association)
               .group(:id)
               .select("#{table_name}.*, COUNT(#{association.to_s.pluralize}.id) as #{counter_cache_column}")
        end
      end
    end

    # Efficiently load records for API responses
    # Includes minimal necessary associations
    def for_api
      select(column_names - %w[created_at updated_at])
    end

    # Efficiently load records for list views
    # Includes associations needed for display
    def for_list
      with_common_associations
    end

    # Efficiently load records for detail views
    # Includes all necessary associations
    def for_detail
      with_common_associations
    end

    # Batch load records to prevent memory issues
    # Processes records in batches
    def in_efficient_batches(batch_size: 1000, &block)
      find_each(batch_size: batch_size, &block)
    end

    # Pluck multiple columns efficiently
    # Returns array of hashes instead of arrays
    def pluck_to_hash(*keys)
      pluck(*keys).map do |values|
        keys.zip(values).to_h
      end
    end

    # Efficiently check if any records exist
    # Uses exists? instead of loading records
    def any_exist?
      exists?
    end

    # Efficiently get first record
    # Uses limit(1) instead of loading all records
    def first_efficiently
      limit(1).first
    end

    # Efficiently get last record
    # Uses limit(1) with reverse order
    def last_efficiently
      reorder(id: :desc).limit(1).first
    end
  end

  # Instance methods for efficient operations
  def reload_with_associations(*associations)
    self.class.includes(*associations).find(id)
  end

  # Efficiently check if association is loaded
  def association_loaded?(association_name)
    association(association_name).loaded?
  end

  # Load association if not already loaded
  def ensure_association_loaded(association_name)
    return if association_loaded?(association_name)
    association(association_name).load_target
  end
end
