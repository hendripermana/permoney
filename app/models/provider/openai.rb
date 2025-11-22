class Provider::Openai < Provider
  include LlmConcept

  # Subclass so errors caught in this provider are raised as Provider::Openai::Error
  Error = Class.new(Provider::Error)

  # Supported OpenAI model prefixes (e.g., "gpt-4" matches "gpt-4", "gpt-4.1", "gpt-4-turbo", etc.)
  DEFAULT_OPENAI_MODEL_PREFIXES = %w[gpt-4 gpt-5 o1 o3]
  DEFAULT_MODEL = "gpt-4.1"

  # Returns the effective model that would be used by the provider
  # Uses the same logic as Provider::Registry and the initializer
  def self.effective_model
    configured_model = ENV.fetch("OPENAI_MODEL", Setting.openai_model)
    configured_model.presence || DEFAULT_MODEL
  end

  def initialize(access_token, uri_base: nil, model: nil)
    client_options = { access_token: access_token }
    client_options[:uri_base] = uri_base if uri_base.present?

    @client = ::OpenAI::Client.new(**client_options)
    @uri_base = uri_base
    if custom_provider? && model.blank?
      raise Error, "Model is required when using a custom OpenAI‑compatible provider"
    end
    @default_model = model.presence || DEFAULT_MODEL
  end

  def supports_model?(model)
    # If using custom uri_base, support any model
    return true if custom_provider?

    # Otherwise, check if model starts with any supported OpenAI prefix
    DEFAULT_OPENAI_MODEL_PREFIXES.any? { |prefix| model.start_with?(prefix) }
  end

  def provider_name
    custom_provider? ? "Custom OpenAI-compatible (#{@uri_base})" : "OpenAI"
  end

  def supported_models_description
    if custom_provider?
      @default_model.present? ? "configured model: #{@default_model}" : "any model"
    else
      "models starting with: #{DEFAULT_OPENAI_MODEL_PREFIXES.join(', ')}"
    end
  end

  def custom_provider?
    @uri_base.present?
  end

  def auto_categorize(transactions: [], user_categories: [], model: "", family: nil)
    with_provider_response do
      raise Error, "Too many transactions to auto-categorize. Max is 25 per request." if transactions.size > 25
      if user_categories.blank?
        family_id = family&.id || "unknown"
        Rails.logger.error("Cannot auto-categorize transactions for family #{family_id}: no categories available")
        raise Error, "No categories available for auto-categorization"
      end

      effective_model = model.presence || @default_model

      trace = create_langfuse_trace(
        name: "openai.auto_categorize",
        input: { transactions: transactions, user_categories: user_categories }
      )

      result = AutoCategorizer.new(
        client,
        model: effective_model,
        transactions: transactions,
        user_categories: user_categories,
        custom_provider: custom_provider?,
        langfuse_trace: trace,
        family: family
      ).auto_categorize

      trace&.update(output: result.map(&:to_h))

      result
    end
  end

  def auto_detect_merchants(transactions: [], user_merchants: [], model: "", family: nil)
    with_provider_response do
      raise Error, "Too many transactions to auto-detect merchants. Max is 25 per request." if transactions.size > 25

      effective_model = model.presence || @default_model

      trace = create_langfuse_trace(
        name: "openai.auto_detect_merchants",
        input: { transactions: transactions, user_merchants: user_merchants }
      )

      result = AutoMerchantDetector.new(
        client,
        model: effective_model,
        transactions: transactions,
        user_merchants: user_merchants,
        custom_provider: custom_provider?,
        langfuse_trace: trace,
        family: family
      ).auto_detect_merchants

      trace&.update(output: result.map(&:to_h))

      result
    end
  end

  def chat_response(
    prompt,
    model:,
    instructions: nil,
    functions: [],
    function_results: [],
    streamer: nil,
    previous_response_id: nil,
    session_id: nil,
    user_identifier: nil,
    family: nil
  )
    # Always use generic_chat_response which uses the standard client.chat API
    # This supports both OpenAI and OpenRouter (and other compatible providers)
    generic_chat_response(
      prompt: prompt,
      model: model,
      instructions: instructions,
      functions: functions,
      function_results: function_results,
      streamer: streamer,
      session_id: session_id,
      user_identifier: user_identifier,
      family: family
    )
  end

  private
    attr_reader :client

    # native_chat_response is deprecated/unused as it targets a non-standard API
    def native_chat_response(*args); end

    def generic_chat_response(
      prompt:,
      model:,
      instructions: nil,
      functions: [],
      function_results: [],
      streamer: nil,
      session_id: nil,
      user_identifier: nil,
      family: nil
    )
      with_provider_response do
        messages = build_generic_messages(
          prompt: prompt,
          instructions: instructions,
          function_results: function_results
        )

        tools = build_generic_tools(functions)

        params = {
          model: model,
          messages: messages
        }
        params[:tools] = tools if tools.present?

        accumulated_content = ""
        accumulated_usage = nil
        response_id = nil

        if streamer.present?
          params[:stream] = proc do |chunk, _bytes|
            # Handle standard OpenAI chunk
            delta = chunk.dig("choices", 0, "delta")
            content = delta&.dig("content")

            # Capture ID from first chunk
            response_id ||= chunk.dig("id")

            if content.present?
              accumulated_content += content
              streamer.call(Provider::LlmConcept::ChatStreamChunk.new(type: "output_text", data: content, usage: nil))
            end

            # Handle usage if present (OpenRouter/OpenAI might send it in the last chunk)
            if chunk.dig("usage")
              accumulated_usage = chunk.dig("usage")
            end
          end
        end

        begin
          raw_response = client.chat(parameters: params)

          if streamer.present?
            # Construct response from accumulated content
            parsed = Provider::LlmConcept::ChatResponse.new(
              id: response_id || "chatcmpl-streamed",
              model: model,
              messages: [
                Provider::LlmConcept::ChatMessage.new(
                  id: response_id || "msg-streamed",
                  output_text: accumulated_content
                )
              ],
              function_requests: []
            )

            log_langfuse_generation(
              name: "chat_response",
              model: model,
              input: messages,
              output: accumulated_content,
              usage: accumulated_usage,
              session_id: session_id,
              user_identifier: user_identifier
            )

            record_llm_usage(family: family, model: model, operation: "chat", usage: accumulated_usage)

            # Emit response chunk for the streamer to finish
            streamer.call(Provider::LlmConcept::ChatStreamChunk.new(type: "response", data: parsed, usage: accumulated_usage))

            parsed
          else
            parsed = GenericChatParser.new(raw_response).parsed

            log_langfuse_generation(
              name: "chat_response",
              model: model,
              input: messages,
              output: parsed.messages.map(&:output_text).join("\n"),
              usage: raw_response["usage"],
              session_id: session_id,
              user_identifier: user_identifier
            )

            record_llm_usage(family: family, model: model, operation: "chat", usage: raw_response["usage"])

            parsed
          end
        rescue => e
          log_langfuse_generation(
            name: "chat_response",
            model: model,
            input: messages,
            error: e,
            session_id: session_id,
            user_identifier: user_identifier
          )
          raise
        end
      end
    end

    def build_generic_messages(prompt:, instructions: nil, function_results: [])
      messages = []

      # Add system message if instructions present
      if instructions.present?
        messages << { role: "system", content: instructions }
      end

      # Add user prompt
      messages << { role: "user", content: prompt }

      # If there are function results, we need to add the assistant message that made the tool calls
      # followed by the tool messages with the results
      if function_results.any?
        # Build assistant message with tool_calls
        tool_calls = function_results.map do |fn_result|
          {
            id: fn_result[:call_id],
            type: "function",
            function: {
              name: fn_result[:name],
              arguments: fn_result[:arguments]
            }
          }
        end

        messages << {
          role: "assistant",
          content: nil,
          tool_calls: tool_calls
        }

        # Add function results as tool messages
        function_results.each do |fn_result|
          # Convert output to JSON string if it's not already a string
          # OpenAI API requires content to be either a string or array of objects
          # Handle nil explicitly to avoid serializing to "null"
          output = fn_result[:output]
          content = if output.nil?
            ""
          elsif output.is_a?(String)
            output
          else
            output.to_json
          end

          messages << {
            role: "tool",
            tool_call_id: fn_result[:call_id],
            name: fn_result[:name],
            content: content
          }
        end
      end

      messages
    end

    def build_generic_tools(functions)
      return [] if functions.blank?

      functions.map do |fn|
        {
          type: "function",
          function: {
            name: fn[:name],
            description: fn[:description],
            parameters: fn[:params_schema],
            strict: fn[:strict]
          }
        }
      end
    end

    def langfuse_client
      return unless ENV["LANGFUSE_PUBLIC_KEY"].present? && ENV["LANGFUSE_SECRET_KEY"].present?

      @langfuse_client = Langfuse.new
    end

    def create_langfuse_trace(name:, input:, session_id: nil, user_identifier: nil)
      return unless langfuse_client

      langfuse_client.trace(
        name: name,
        input: input,
        session_id: session_id,
        user_id: user_identifier
      )
    rescue => e
      Rails.logger.warn("Langfuse trace creation failed: #{e.message}")
      nil
    end

    def log_langfuse_generation(name:, model:, input:, output: nil, usage: nil, error: nil, session_id: nil, user_identifier: nil)
      return unless langfuse_client

      trace = create_langfuse_trace(
        name: "openai.#{name}",
        input: input,
        session_id: session_id,
        user_identifier: user_identifier
      )

      generation = trace&.generation(
        name: name,
        model: model,
        input: input
      )

      if error
        generation&.end(
          output: { error: error.message, details: error.respond_to?(:details) ? error.details : nil },
          level: "ERROR"
        )
        trace&.update(
          output: { error: error.message },
          level: "ERROR"
        )
      else
        generation&.end(output: output, usage: usage)
        trace&.update(output: output)
      end
    rescue => e
      Rails.logger.warn("Langfuse logging failed: #{e.message}")
    end

    def record_llm_usage(family:, model:, operation:, usage:)
      return unless family && usage

      Rails.logger.info("Recording LLM usage - Raw usage data: #{usage.inspect}")

      # Handle both old and new OpenAI API response formats
      # Old format: prompt_tokens, completion_tokens, total_tokens
      # New format: input_tokens, output_tokens, total_tokens
      prompt_tokens = usage["prompt_tokens"] || usage["input_tokens"] || 0
      completion_tokens = usage["completion_tokens"] || usage["output_tokens"] || 0
      total_tokens = usage["total_tokens"] || 0

      Rails.logger.info("Extracted tokens - prompt: #{prompt_tokens}, completion: #{completion_tokens}, total: #{total_tokens}")

      estimated_cost = LlmUsage.calculate_cost(
        model: model,
        prompt_tokens: prompt_tokens,
        completion_tokens: completion_tokens
      )

      # Log when we can't estimate the cost (e.g., custom/self-hosted models)
      if estimated_cost.nil?
        Rails.logger.info("Recording LLM usage without cost estimate for unknown model: #{model} (custom provider: #{custom_provider?})")
      end

      inferred_provider = LlmUsage.infer_provider(model)
      family.llm_usages.create!(
        provider: inferred_provider,
        model: model,
        operation: operation,
        prompt_tokens: prompt_tokens,
        completion_tokens: completion_tokens,
        total_tokens: total_tokens,
        estimated_cost: estimated_cost,
        metadata: {}
      )

      Rails.logger.info("LLM usage recorded successfully - Cost: #{estimated_cost.inspect}")
    rescue => e
      Rails.logger.error("Failed to record LLM usage: #{e.message}")
    end
end
