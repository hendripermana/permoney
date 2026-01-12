# frozen_string_literal: true

module SimplefinItemsHelper
  # Builds a compact tooltip summary of SimpleFIN sync errors.
  def simplefin_error_tooltip(stats)
    return nil unless stats.is_a?(Hash)

    total_errors = stats["total_errors"].to_i
    return nil if total_errors.zero?

    sample = Array(stats["errors"]).map do |entry|
      name = (entry[:name] || entry["name"]).to_s
      msg = (entry[:message] || entry["message"]).to_s
      name.present? ? "#{name}: #{msg}" : msg
    end.compact.first(2).join(" | ")

    buckets = stats["error_buckets"] || {}
    bucket_text = if buckets.present?
      buckets.map { |key, value| "#{key}: #{value}" }.join(", ")
    end

    parts = [ "Errors: ", total_errors.to_s ]
    parts << " (#{bucket_text})" if bucket_text.present?
    parts << " - #{sample}" if sample.present?
    parts.join
  end
end
