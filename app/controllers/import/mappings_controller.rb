class Import::MappingsController < ApplicationController
  before_action :set_import
  before_action :set_mapping

  rescue_from ArgumentError, with: :handle_argument_error
  rescue_from ActiveRecord::RecordNotFound, with: :handle_record_not_found

  def update
    if @mapping.update(mapping_update_params)
      redirect_back_or_to import_confirm_path(@import), notice: "Mapping updated successfully"
    else
      redirect_back_or_to import_confirm_path(@import), alert: "Failed to update mapping: #{@mapping.errors.full_messages.join(', ')}"
    end
  end

  private
    # Security: Only allow whitelisted mapping classes to prevent mass assignment vulnerabilities
    ALLOWED_MAPPING_CLASSES = {
      "Import::AccountTypeMapping" => Import::AccountTypeMapping,
      "Import::AccountMapping" => Import::AccountMapping,
      "Import::CategoryMapping" => Import::CategoryMapping,
      "Import::TagMapping" => Import::TagMapping
    }.freeze

    # Security: Only allow whitelisted mappable classes
    ALLOWED_MAPPABLE_CLASSES = {
      "Account" => Account,
      "Category" => Category,
      "Tag" => Tag
    }.freeze

    def set_import
      @import = Current.family.imports.find(params[:import_id])
    end

    def set_mapping
      @mapping = @import.mappings.find(params[:id])
    end

    def mapping_update_params
      permitted_params = mapping_params.permit(:key, :value, :mappable_id, :mappable_type, :type)

      validate_mapping_type!(permitted_params[:type])
      build_update_hash(permitted_params)
    end

    def validate_mapping_type!(mapping_type)
      unless mapping_type&.in?(ALLOWED_MAPPING_CLASSES.keys)
        raise ArgumentError, "Invalid or missing mapping type: #{mapping_type.inspect}"
      end

      unless @mapping.type == mapping_type
        raise ArgumentError, "Mapping type mismatch: expected #{@mapping.type}, got #{mapping_type}"
      end
    end

    def build_update_hash(permitted_params)
      update_hash = {
        key: permitted_params[:key],
        value: permitted_params[:value]
      }

      mappable_type_str = permitted_params[:mappable_type]&.to_s

      if mappable_type_str
        handle_mappable_assignment(update_hash, permitted_params, mappable_type_str)
      else
        # For mappings without mappable (like AccountTypeMapping)
        update_hash.merge(mappable: nil, create_when_empty: false)
      end
    end

    def handle_mappable_assignment(update_hash, permitted_params, mappable_type_str)
      mappable_class = ALLOWED_MAPPABLE_CLASSES[mappable_type_str]
      raise ArgumentError, "Invalid mappable type: #{mappable_type_str}" unless mappable_class

      validate_mappable_type_match!(mappable_class, mappable_type_str)

      mappable_id = permitted_params[:mappable_id]

      case mappable_id
      when Import::Mapping::CREATE_NEW_KEY.to_s
        update_hash.merge(create_when_empty: true, mappable: nil)
      when ->(id) { id.present? }
        mappable = find_mappable!(mappable_class, mappable_id)
        update_hash.merge(mappable: mappable, create_when_empty: false)
      else
        update_hash.merge(mappable: nil, create_when_empty: false)
      end
    end

    def validate_mappable_type_match!(mappable_class, mappable_type_str)
      expected_class = @mapping.mappable_class
      return if expected_class.nil? || expected_class.to_s == mappable_type_str

      raise ArgumentError, "Mappable type mismatch: mapping expects #{expected_class}, got #{mappable_type_str}"
    end

    def find_mappable!(mappable_class, mappable_id)
      mappable_class.find_by(id: mappable_id, family: Current.family) ||
        raise(ActiveRecord::RecordNotFound, "Mappable not found or doesn't belong to family")
    end

    def mapping_params
      params.require(:import_mapping)
    end

    def handle_argument_error(exception)
      Rails.logger.error "Invalid mapping update: #{exception.message}"
      redirect_back_or_to import_confirm_path(@import), alert: "Invalid mapping parameters"
    end

    def handle_record_not_found(exception)
      Rails.logger.error "Mappable not found: #{exception.message}"
      redirect_back_or_to import_confirm_path(@import), alert: "Selected resource not found"
    end
end
