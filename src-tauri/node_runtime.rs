pub const NODE_REQUIREMENT: &str =
    "Node.js 22.23.4+, 24.22.2+, or 26.12.1+ (stable releases within those major versions)";

pub fn validate_node_version(output: &str) -> Result<(), String> {
    let invalid = || format!("Unexpected Node version output: {output:?}");
    let version = output.trim().strip_prefix('v').ok_or_else(invalid)?;
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return Err(invalid());
    }
    let major = parts[0].parse::<u32>().map_err(|_| invalid())?;
    let minor = parts[1].parse::<u32>().map_err(|_| invalid())?;
    let patch = parts[2].parse::<u32>().map_err(|_| invalid())?;

    // Security floors include the CVE-2026-111497 Brotli decoder fix.
    let minimum = match major {
        22 => (23, 4),
        24 => (22, 2),
        26 => (12, 1),
        _ => {
            return Err(format!(
                "Node {version} is unsupported; use {NODE_REQUIREMENT}"
            ))
        }
    };
    if (minor, patch) < minimum {
        return Err(format!(
            "Node {version} predates the required security fixes; use {NODE_REQUIREMENT}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_node_version;

    #[test]
    fn accepts_patched_stable_releases_in_supported_branches() {
        for version in [
            "v22.23.4",
            "v22.23.5",
            "v22.24.0",
            "v24.22.2",
            "v24.23.0",
            "v26.12.1",
            "v26.13.0",
            "v24.22.2\r\n",
        ] {
            assert!(validate_node_version(version).is_ok(), "{version}");
        }
    }

    #[test]
    fn rejects_unpatched_releases_and_the_superseded_node_24_patch() {
        for version in [
            "v22.12.0",
            "v22.23.3",
            "v22.22.99",
            "v24.13.0",
            "v24.21.99",
            "v24.22.0",
            "v24.22.1",
            "v26.11.99",
            "v26.12.0",
        ] {
            assert!(validate_node_version(version).is_err(), "{version}");
        }
    }

    #[test]
    fn rejects_end_of_life_and_unreviewed_major_versions() {
        for version in ["v16.20.2", "v20.99.0", "v23.99.0", "v25.99.0", "v27.0.0"] {
            assert!(validate_node_version(version).is_err(), "{version}");
        }
    }

    #[test]
    fn rejects_prerelease_and_malformed_version_output() {
        for version in [
            "",
            "24.22.2",
            "v24",
            "v24.22",
            "v24.22.2.0",
            "v24.22.2-rc.1",
            "v24.22.2+custom",
            "v24.22.2\nv26.13.0",
            "v+24.22.2",
            "v024.22.2",
            "v24.22.4294967296",
        ] {
            assert!(validate_node_version(version).is_err(), "{version}");
        }
    }
}
