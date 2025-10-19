class Import::MappingsController < ApplicationController
  before_action :set_import

  def update
    mapping = @import.mappings.find(params[:id])

    mapping.update! \
      create_when_empty: create_when_empty,
      mappable: mappable,
      value: mapping_params[:value]

    redirect_back_or_to import_confirm_path(@import)
  end

  private
    # Only permit these class names for mapping_class and mappable_class.
    ALLOWED_MAPPING_CLASSES = {
      "AllowedTypeA" => AllowedTypeA,
      "AllowedTypeB" => AllowedTypeB
      # add more allowed classes here
    }.freeze

    ALLOWED_MAPPABLE_CLASSES = {
      "AllowedMappableA" => AllowedMappableA,
      "AllowedMappableB" => AllowedMappableB
      # add more allowed mappable classes here
    }.freeze

    def mapping_params
      params.require(:import_mapping).permit(:type, :key, :mappable_id, :mappable_type, :value)
    end

    def set_import
      @import = Current.family.imports.find(params[:import_id])
    end

    def mappable
      return nil unless mappable_class.present?

      @mappable ||= mappable_class.find_by(id: mapping_params[:mappable_id], family: Current.family)
    end

    def create_when_empty
      return false unless mapping_class.present?

      mapping_params[:mappable_id] == mapping_class::CREATE_NEW_KEY
    end

    def mappable_class
      ALLOWED_MAPPABLE_CLASSES[mapping_params[:mappable_type]]
    end

    def mapping_class
      ALLOWED_MAPPING_CLASSES[mapping_params[:type]]
    end
end
