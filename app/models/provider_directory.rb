class ProviderDirectory < ApplicationRecord
  KINDS = {
    bank: "bank",
    pawnshop: "pawnshop",
    bullion_dealer: "bullion_dealer",
    broker: "broker",
    cooperative: "cooperative",
    other: "other"
  }.freeze

  belongs_to :user

  enum :kind, KINDS, suffix: true, validate: true

  normalizes :name, with: ->(value) { value.to_s.strip.presence }
  normalizes :website, with: ->(value) { value.to_s.strip.presence }

  validates :name, presence: true, uniqueness: { scope: :user_id, case_sensitive: false }
  validate :website_format, if: -> { website.present? }

  scope :active, -> { where(archived_at: nil) }
  scope :archived, -> { where.not(archived_at: nil) }
  scope :alphabetically, -> { order(Arel.sql("LOWER(name)")) }
  scope :search, ->(query) {
    return all if query.blank?

    where("LOWER(name) LIKE ?", "%#{query.downcase}%")
  }

  def archive!
    # Providers are archived in UI; FK prevents deletion while referenced by accounts.
    update!(archived_at: Time.current)
  end

  def restore!
    update!(archived_at: nil)
  end

  def kind_label
    kind.to_s.tr("_", " ").titleize
  end

  def to_combobox_option
    ProviderDirectory::ComboboxOption.new(id: id, name: name, kind: kind)
  end

  def to_combobox_display
    name
  end

  def website_url
    return nil if website.blank?

    uri = URI.parse(website)
    return nil unless uri.is_a?(URI::HTTP) && uri.host.present?

    uri.to_s
  rescue URI::InvalidURIError
    nil
  end

  private
    def website_format
      return if website_url.present?

      errors.add(:website, "must be a valid http or https URL")
    end
end

class ProviderDirectory::ComboboxOption
  include ActiveModel::Model

  attr_accessor :id, :name, :kind

  def to_combobox_display
    name
  end

  def kind_label
    kind.to_s.tr("_", " ").titleize
  end
end
