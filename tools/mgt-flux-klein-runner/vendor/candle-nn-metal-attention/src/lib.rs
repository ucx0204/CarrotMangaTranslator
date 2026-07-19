//! Candle NN compatibility layer for Flux.2 Klein on Metal.
//!
//! Candle's fused Metal SDPA both limits supported head dimensions and produces
//! corrupted Flux.2 transformer output on the supported 128-wide heads. Route
//! Flux's unmasked, non-causal attention through bounded Metal matmuls instead.

macro_rules! reexport_module {
    ($name:ident) => {
        pub mod $name {
            pub use candle_nn_upstream::$name::*;
        }
    };
}

reexport_module!(activation);
reexport_module!(batch_norm);
reexport_module!(conv);
reexport_module!(cpu_flash_attention);
reexport_module!(embedding);
reexport_module!(encoding);
reexport_module!(func);
reexport_module!(group_norm);
reexport_module!(init);
reexport_module!(kv_cache);
reexport_module!(layer_norm);
reexport_module!(linear);
reexport_module!(loss);
reexport_module!(optim);
reexport_module!(rnn);
reexport_module!(rotary_emb);
reexport_module!(sampling);
reexport_module!(sequential);
reexport_module!(var_builder);
reexport_module!(var_map);
pub use candle_nn_upstream::batch_norm::batch_norm;
pub use candle_nn_upstream::embedding::embedding;
pub use candle_nn_upstream::func::func;
pub use candle_nn_upstream::group_norm::group_norm;
pub use candle_nn_upstream::layer_norm::layer_norm;
pub use candle_nn_upstream::linear::linear;
pub use candle_nn_upstream::{
    conv1d, conv1d_no_bias, conv2d, conv2d_no_bias, conv_transpose1d, conv_transpose1d_no_bias,
    conv_transpose2d, conv_transpose2d_no_bias, func_t, gru, layer_norm_no_bias, linear_b,
    linear_no_bias, lstm, prelu, rms_norm, seq, Activation, AdamW, BatchNorm, BatchNormConfig,
    Conv1d, Conv1dConfig, Conv2d, Conv2dConfig, ConvTranspose1d, ConvTranspose1dConfig,
    ConvTranspose2d, ConvTranspose2dConfig, Embedding, Func, FuncT, GRUConfig, GroupNorm, Init,
    LSTMConfig, LayerNorm, LayerNormConfig, Linear, Module, ModuleT, Optimizer, PReLU, ParamsAdamW,
    RmsNorm, Sequential, VarBuilder, VarMap, GRU, LSTM, RNN, SGD,
};

pub mod ops {
    use std::sync::Once;

    use candle_core::{DType, Result, Tensor, D};

    pub use candle_nn_upstream::ops::{
        dropout, hard_sigmoid, layer_norm, layer_norm_slow, leaky_relu, log_softmax, mish,
        pixel_shuffle, pixel_unshuffle, replication_pad2d, rms_norm, rms_norm_slow, selu, sigmoid,
        silu, softmax, softmax_last_dim, swiglu, Dropout, Identity,
    };

    static METAL_CHUNKED_ATTENTION_LOG: Once = Once::new();

    pub fn sdpa(
        q: &Tensor,
        k: &Tensor,
        v: &Tensor,
        mask: Option<&Tensor>,
        do_causal: bool,
        scale: f32,
        softcapping: f32,
    ) -> Result<Tensor> {
        let head_dim = q.dim(D::Minus1)?;
        let can_use_flux_chunking =
            q.device().is_metal() && mask.is_none() && !do_causal && softcapping == 1.0;
        if can_use_flux_chunking {
            METAL_CHUNKED_ATTENTION_LOG.call_once(|| {
                eprintln!(
                    "mgt-flux-klein: using numerically stable Metal chunked attention (head dim {head_dim})"
                );
            });
            return chunked_attention(q, k, v, scale, attention_chunk_size(q)?);
        }
        candle_nn_upstream::ops::sdpa(q, k, v, mask, do_causal, scale, softcapping)
    }

    fn attention_chunk_size(q: &Tensor) -> Result<usize> {
        Ok(if q.dim(2)? > 4096 { 64 } else { 128 })
    }

    fn chunked_attention(
        q: &Tensor,
        k: &Tensor,
        v: &Tensor,
        scale: f32,
        chunk_size: usize,
    ) -> Result<Tensor> {
        // Keep the score matrix bounded without forcing the transformer through
        // dozens of tiny Metal command buffers for normal inpainting crops.
        const KEY_CHUNK_SIZE: usize = 1024;

        let (batch, heads, query_len, _) = q.dims4()?;
        let key_len = k.dim(2)?;
        let value_dim = v.dim(D::Minus1)?;
        let output_dtype = q.dtype();
        let mut chunks = Vec::with_capacity(query_len.div_ceil(chunk_size));
        for query_start in (0..query_len).step_by(chunk_size) {
            let query_chunk_len = chunk_size.min(query_len - query_start);
            let query = q
                .narrow(2, query_start, query_chunk_len)?
                .contiguous()?
                .to_dtype(DType::F32)?;
            let mut output_accumulator = Tensor::from_vec(
                vec![0f32; batch * heads * query_chunk_len * value_dim],
                (batch, heads, query_chunk_len, value_dim),
                q.device(),
            )?;
            let mut max_scores = Tensor::from_vec(
                vec![f32::NEG_INFINITY; batch * heads * query_chunk_len],
                (batch, heads, query_chunk_len, 1),
                q.device(),
            )?;
            let mut exponential_sum = Tensor::from_vec(
                vec![0f32; batch * heads * query_chunk_len],
                (batch, heads, query_chunk_len, 1),
                q.device(),
            )?;

            for key_start in (0..key_len).step_by(KEY_CHUNK_SIZE) {
                let key_chunk_len = KEY_CHUNK_SIZE.min(key_len - key_start);
                let key = k
                    .narrow(2, key_start, key_chunk_len)?
                    .contiguous()?
                    .to_dtype(DType::F32)?;
                let value = v
                    .narrow(2, key_start, key_chunk_len)?
                    .contiguous()?
                    .to_dtype(DType::F32)?;
                let scores = (query.matmul(&key.transpose(2, 3)?.contiguous()?)? * scale as f64)?;
                let tile_max = scores.max_keepdim(D::Minus1)?;
                let next_max = max_scores.maximum(&tile_max)?;
                let previous_scale = (&max_scores - &next_max)?.exp()?;
                output_accumulator = output_accumulator.broadcast_mul(&previous_scale)?;
                exponential_sum = exponential_sum.broadcast_mul(&previous_scale)?;
                let exponentials = scores.broadcast_sub(&next_max)?.exp()?;
                output_accumulator = (output_accumulator + exponentials.matmul(&value)?)?;
                exponential_sum = (exponential_sum + exponentials.sum_keepdim(D::Minus1)?)?;
                max_scores = next_max;
            }
            chunks.push(
                output_accumulator
                    .broadcast_div(&exponential_sum)?
                    .to_dtype(output_dtype)?,
            );
        }
        Tensor::cat(&chunks, 2)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use candle_core::{Device, Tensor};

        #[test]
        fn chunked_attention_matches_full_attention() -> Result<()> {
            let device = Device::Cpu;
            let q = (Tensor::arange(0f32, 12f32, &device)? / 12.0)?.reshape((1, 1, 4, 3))?;
            let k = (Tensor::arange(1f32, 13f32, &device)? / 13.0)?.reshape((1, 1, 4, 3))?;
            let v = (Tensor::arange(0f32, 8f32, &device)? / 8.0)?.reshape((1, 1, 4, 2))?;
            let scale = 1.0 / 3f32.sqrt();
            let scores = (q.matmul(&k.transpose(2, 3)?.contiguous()?)? * scale as f64)?;
            let expected = softmax_last_dim(&scores)?.matmul(&v)?;
            let actual = chunked_attention(&q, &k, &v, scale, 2)?;
            let delta = (&expected - &actual)?
                .abs()?
                .max_all()?
                .to_scalar::<f32>()?;
            assert!(delta < 1e-5, "chunked attention delta was {delta}");
            Ok(())
        }

        #[cfg(feature = "metal")]
        #[test]
        fn metal_chunked_attention_matches_cpu_for_flux_vae_head_dim() -> Result<()> {
            let cpu = Device::Cpu;
            let metal = Device::new_metal(0)?;
            let query_elements = 4 * 512;
            let key_len = 1031;
            let key_elements = key_len * 512;
            let q_cpu = (Tensor::arange(0f32, query_elements as f32, &cpu)?
                / query_elements as f64)?
                .reshape((1, 1, 4, 512))?;
            let k_cpu = (Tensor::arange(1f32, (key_elements + 1) as f32, &cpu)?
                / (key_elements + 1) as f64)?
                .reshape((1, 1, key_len, 512))?;
            let v_cpu = (Tensor::arange(0f32, key_elements as f32, &cpu)?
                / (key_elements * 2) as f64)?
                .reshape((1, 1, key_len, 512))?;
            let scale = 1.0 / 512f32.sqrt();
            let scores = (q_cpu.matmul(&k_cpu.transpose(2, 3)?.contiguous()?)? * scale as f64)?;
            let expected = softmax_last_dim(&scores)?.matmul(&v_cpu)?;
            let actual = chunked_attention(
                &q_cpu.to_device(&metal)?,
                &k_cpu.to_device(&metal)?,
                &v_cpu.to_device(&metal)?,
                scale,
                2,
            )?
            .to_device(&cpu)?;
            let delta = (&expected - &actual)?
                .abs()?
                .max_all()?
                .to_scalar::<f32>()?;
            assert!(delta < 1e-4, "Metal chunked attention delta was {delta}");
            Ok(())
        }
    }
}

pub use ops::Dropout;
