# frozen_string_literal: true

class Provider::Openai::StreamingChat
  # Universal streaming wrapper for OpenAI-compatible APIs
  # Supports: OpenAI, OpenRouter, local LLMs, and custom endpoints
  #
  # Example:
  #   streaming_chat = Provider::Openai::StreamingChat.new(
  #     client: openai_client,
  #     model: "gpt-4.1",
  #     messages: [{ role: "user", content: "Hello" }],
  #     tools: function_definitions
  #   )
  #
  #   streaming_chat.stream do |event|
  #     case event[:type]
  #     when :text_delta
  #       puts event[:content]
  #     when :complete
  #       puts "Done!"
  #     end
  #   end

  def initialize(client:, model:, messages:, tools: [], custom_provider: false, **options)
    @client = client
    @model = model
    @messages = messages
    @tools = tools
    @custom_provider = custom_provider
    @options = options
    @stopped = false
  end

  # Stream chat completion with real-time events
  # Yields events: :text_delta, :tool_calls, :complete, :error
  def stream(&block)
    raise ArgumentError, "Block required for streaming" unless block_given?

    params = build_params

    accumulated_content = ""
    response_id = nil
    accumulated_usage = nil
    tool_calls_accumulator = {}

    begin
      # Use official openai-ruby gem streaming
      # Works with OpenAI, OpenRouter, and all compatible APIs
      @client.chat(parameters: params.merge(
        stream: proc do |chunk, _bytes|
          # Check if streaming was stopped
          break if @stopped

          # Parse standard OpenAI/OpenRouter streaming format
          delta = chunk.dig("choices", 0, "delta")

          # Capture response ID from first chunk
          response_id ||= chunk.dig("id")

          # Handle text content streaming
          if delta && (content = delta["content"])
            accumulated_content += content
            yield({
              type: :text_delta,
              content: content,
              message_id: response_id
            })
          end

          # Handle tool/function calls streaming
          if delta && delta["tool_calls"]
            delta["tool_calls"].each do |tool_call_chunk|
              index = tool_call_chunk["index"]
              tool_calls_accumulator[index] ||= {
                "id" => "",
                "type" => "function",
                "function" => { "name" => "", "arguments" => "" }
              }

              # Accumulate tool call data
              if tool_call_chunk["id"]
                tool_calls_accumulator[index]["id"] = tool_call_chunk["id"]
              end

              if tool_call_chunk["function"]
                if tool_call_chunk["function"]["name"]
                  tool_calls_accumulator[index]["function"]["name"] += tool_call_chunk["function"]["name"]
                end
                if tool_call_chunk["function"]["arguments"]
                  tool_calls_accumulator[index]["function"]["arguments"] += tool_call_chunk["function"]["arguments"]
                end
              end
            end
          end

          # Capture usage data (OpenRouter and some providers send this)
          if chunk.dig("usage")
            accumulated_usage = chunk.dig("usage")
          end

          # Handle stream completion
          finish_reason = chunk.dig("choices", 0, "finish_reason")
          if finish_reason
            # Convert tool_calls_accumulator to array
            tool_calls = tool_calls_accumulator.values if tool_calls_accumulator.any?

            yield({
              type: :complete,
              content: accumulated_content,
              response_id: response_id,
              usage: accumulated_usage,
              finish_reason: finish_reason,
              tool_calls: tool_calls
            })
          end
        end
      ))
    rescue => e
      # Handle provider-specific errors gracefully
      yield({ type: :error, error: e })
      raise
    end

    # Return accumulated data
    {
      content: accumulated_content,
      response_id: response_id,
      usage: accumulated_usage,
      tool_calls: tool_calls_accumulator.values
    }
  end

  # Stop streaming (called from external context)
  def stop!
    @stopped = true
  end

  def stopped?
    @stopped
  end

  private

    def build_params
      params = {
        model: @model,
        messages: @messages,
        stream: true
      }

      # Add tools if present (for function calling)
      params[:tools] = @tools if @tools.present?

      # Merge additional options (temperature, max_tokens, etc.)
      params.merge(@options)
    end
end
