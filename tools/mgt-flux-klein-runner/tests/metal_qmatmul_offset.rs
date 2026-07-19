#[cfg(feature = "metal")]
use candle_core::{
    Device, Module, Result, Tensor,
    quantized::{GgmlDType, QMatMul, QTensor},
};

#[cfg(feature = "metal")]
#[test]
fn quantized_metal_matmul_respects_flux_image_view_offset() -> Result<()> {
    const CHANNELS: usize = 256;
    const TEXT_TOKENS: usize = 512;

    let cpu = Device::Cpu;
    let metal = Device::new_metal(0)?;
    let weights = Tensor::from_vec(
        deterministic_values(CHANNELS * CHANNELS, 0),
        (CHANNELS, CHANNELS),
        &cpu,
    )?;
    let weights = QTensor::quantize_onto(&weights, GgmlDType::Q4K, &metal)?;
    let projection = QMatMul::from_qtensor(weights)?;

    for image_tokens in [880usize, 2_736usize] {
        let image_values = deterministic_values(image_tokens * CHANNELS, TEXT_TOKENS * CHANNELS);
        let offset_zero = Tensor::from_vec(image_values, (1, image_tokens, CHANNELS), &metal)?;
        let joined = Tensor::from_vec(
            deterministic_values((TEXT_TOKENS + image_tokens) * CHANNELS, 0),
            (1, TEXT_TOKENS + image_tokens, CHANNELS),
            &metal,
        )?;
        let offset_view = joined.narrow(1, TEXT_TOKENS, image_tokens)?;

        let expected = projection.forward(&offset_zero)?;
        let actual = projection.forward(&offset_view)?;
        let max_delta = (&expected - &actual)?
            .abs()?
            .max_all()?
            .to_scalar::<f32>()?;
        assert!(
            max_delta <= 1e-5,
            "image_tokens={image_tokens} max_delta={max_delta}"
        );
    }
    Ok(())
}

#[cfg(feature = "metal")]
fn deterministic_values(len: usize, offset: usize) -> Vec<f32> {
    (0..len)
        .map(|index| {
            let value = ((index + offset) % 251) as f32;
            (value - 125.0) / 125.0
        })
        .collect()
}
